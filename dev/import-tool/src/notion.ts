//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//
import {
  generateId,
  type AttachedData,
  type Ref,
  makeCollaborativeDoc,
  type TxOperations,
  type Blob,
  collaborativeDocParse
} from '@hcengineering/core'
import { yDocToBuffer } from '@hcengineering/collaboration'
import document, { type Document, type Teamspace, getFirstRank } from '@hcengineering/document'
import { makeRank } from '@hcengineering/rank'
import {
  MarkupMarkType,
  type MarkupNode,
  MarkupNodeType,
  parseMessageMarkdown,
  traverseNode,
  traverseNodeMarks,
  jsonToYDocNoSchema
} from '@hcengineering/text'

import attachment from '@hcengineering/model-attachment'
import { type Attachment } from '@hcengineering/attachment'
import { contentType } from 'mime-types'
import core from '@hcengineering/model-core'
import { readdir, stat, readFile } from 'fs/promises'
import { type Dirent } from 'fs'
import { basename, join, parse } from 'path'

interface DocumentMetadata {
  id: string
  name: string
  notionId: string
  notionSubRootId?: string
  notionParentId?: string
  mimeType?: string
  size?: number
}

interface FileMetadata {
  isFolder: boolean
  level: number
  hasChildren: boolean
  fileName: string
  extension?: string
}

const MD_EXTENSION = '.md'
const CSV_EXTENSION = '.csv'
const DEFAULT_ATTACHMENT_MIME_TYPE = 'application/octet-stream'

enum NOTION_MD_LINK_TYPES {
  INTERNAL_LINK,
  EXTERNAL_LINK,
  ATTACHMENT,
  UNKNOWN
}

export type FileUploader = (id: string, data: any) => Promise<any>

export async function importNotion (
  client: TxOperations,
  uploadFile: FileUploader,
  dir: string,
  teamspace?: string
): Promise<void> {
  const files = await getFilesForImport(dir)

  const fileMetaMap = new Map<string, FileMetadata>()
  const documentMetaMap = new Map<string, DocumentMetadata>()

  await collectMetadata(dir, files, fileMetaMap, documentMetaMap)
  console.log(fileMetaMap)
  console.log(documentMetaMap)

  if (teamspace === undefined) {
    const spaceIdMap = await createTeamspaces(fileMetaMap, client)
    if (spaceIdMap.size === 0) {
      console.error('No teamspaces found in directory: ', dir)
      return
    }
    await importFiles(client, uploadFile, fileMetaMap, documentMetaMap, spaceIdMap)
  } else {
    const spaceId = await createTeamspace(teamspace, client)
    await importFilesToSpace(client, uploadFile, fileMetaMap, documentMetaMap, spaceId)
  }
}

async function getFilesForImport (dir: string): Promise<Dirent[]> {
  const filesAndDirs = await readdir(dir, { recursive: true, withFileTypes: true })
  const files = filesAndDirs.filter((file) => {
    return !file.isDirectory() && !(file.name === 'index.html' && file.path === dir)
  })
  return files
}

async function collectMetadata (
  root: string,
  files: Dirent[],
  fileMetaMap: Map<string, FileMetadata>,
  documentMetaMap: Map<string, DocumentMetadata>
): Promise<void> {
  for (const file of files) {
    const st = await stat(file.path)
    collectFileMetadata(root, file, st.size, fileMetaMap, documentMetaMap)
  }
}

function collectFileMetadata (
  root: string,
  file: Dirent,
  fileSize: number,
  fileMetaMap: Map<string, FileMetadata>,
  documentMetaMap: Map<string, DocumentMetadata>
): void {
  const notionId = getFileId(file.path, file.name)
  const extension = extractExtension(file.name)
  const ancestors = getAncestorEntries(root, file.path)
  const meta = fileMetaMap.get(notionId)
  fileMetaMap.set(notionId, {
    level: ancestors.length,
    isFolder: false,
    extension,
    fileName: join(file.path, file.name),
    hasChildren: meta?.hasChildren ?? false
  })

  ancestors.forEach((folder, i) => {
    const id = getFileId('', folder)
    const meta = fileMetaMap.get(id)
    fileMetaMap.set(id, {
      level: meta?.level ?? i,
      isFolder: meta?.isFolder ?? true,
      fileName: meta?.fileName ?? folder,
      extension: meta?.extension,
      hasChildren: true
    })
  })

  const notionParentId =
    ancestors[ancestors.length - 1] !== undefined ? extractNotionId(ancestors[ancestors.length - 1]) : undefined
  const notionSubRootId =
    ancestors[1] !== undefined ? extractNotionId(ancestors[1]) ?? extractOriginalName(ancestors[1]) : undefined

  documentMetaMap.set(notionId, {
    id: generateId(),
    name: extractOriginalName(file.name),
    notionId,
    notionParentId,
    notionSubRootId,
    mimeType: getContentType(file.name),
    size: fileSize
  })
}

async function createTeamspaces (
  fileMetaMap: Map<string, FileMetadata>,
  client: TxOperations
): Promise<Map<string, Ref<Teamspace>>> {
  const spaceIdMap = new Map<string, Ref<Teamspace>>()
  for (const [notionId, meta] of fileMetaMap) {
    if (meta.isFolder && meta.level === 1) {
      console.log('TEAMSPACE: ', meta.fileName)
      const teamspacName = extractOriginalName(meta.fileName)
      const teamspaceId = await createTeamspace(teamspacName, client)
      spaceIdMap.set(notionId, teamspaceId)
    }
  }
  return spaceIdMap
}

async function createTeamspace (name: string, client: TxOperations): Promise<Ref<Teamspace>> {
  const teamspaceId = generateId<Teamspace>()
  const data = {
    type: document.spaceType.DefaultTeamspaceType,
    description: 'Imported from Notion',
    name,
    private: false,
    members: [],
    owners: [],
    autoJoin: false,
    archived: false
  }
  await client.createDoc(document.class.Teamspace, core.space.Space, data, teamspaceId)
  return teamspaceId
}

async function importFilesToSpace (
  client: TxOperations,
  uploadFile: FileUploader,
  fileMetaMap: Map<string, FileMetadata>,
  documentMetaMap: Map<string, DocumentMetadata>,
  spaceId: Ref<Teamspace>
): Promise<void> {
  for (const [notionId, fileMeta] of fileMetaMap) {
    if (!fileMeta.isFolder) {
      const docMeta = documentMetaMap.get(notionId)
      if (docMeta === undefined) throw new Error('Cannot find metadata for entry: ' + fileMeta.fileName)
      await importFile(client, uploadFile, fileMeta, docMeta, spaceId, documentMetaMap)
    }
  }
}

async function importFiles (
  client: TxOperations,
  uploadFile: FileUploader,
  fileMetaMap: Map<string, FileMetadata>,
  documentMetaMap: Map<string, DocumentMetadata>,
  spaceIdMap: Map<string, Ref<Teamspace>>
): Promise<void> {
  for (const [notionId, fileMeta] of fileMetaMap) {
    if (!fileMeta.isFolder) {
      const docMeta = documentMetaMap.get(notionId)
      if (docMeta === undefined) throw new Error('Cannot find metadata for entry: ' + fileMeta.fileName)

      const spaceId = docMeta.notionSubRootId !== undefined && spaceIdMap.get(docMeta.notionSubRootId)
      if (spaceId === undefined || spaceId === false) {
        throw new Error('Teamspace not found for document: ' + docMeta.name)
      }

      await importFile(client, uploadFile, fileMeta, docMeta, spaceId, documentMetaMap)
    }
  }
}

async function importFile (
  client: TxOperations,
  uploadFile: FileUploader,
  fileMeta: FileMetadata,
  docMeta: DocumentMetadata,
  spaceId: Ref<Teamspace>,
  documentMetaMap: Map<string, DocumentMetadata>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (fileMeta.isFolder) throw new Error('Importing folder entry is not supported: ' + fileMeta.fileName)

    console.log('IMPORT STARTED:', fileMeta.fileName)
    readFile(fileMeta.fileName)
      .then((data) => {
        const { notionParentId } = docMeta

        const parentMeta =
          notionParentId !== undefined && notionParentId !== '' ? documentMetaMap.get(notionParentId) : undefined

        const processFileData = getDataProcessor(fileMeta, docMeta)
        processFileData(client, uploadFile, data, docMeta, spaceId, parentMeta, documentMetaMap)
          .then(() => {
            console.log('IMPORT SUCCEED:', docMeta.name)
            console.log('------------------------------------------------------------------')
            resolve()
          })
          .catch((error) => {
            handleImportFailure(docMeta.name, error, reject)
          })
      })
      .catch((error) => {
        handleImportFailure(docMeta.name, error, reject)
      })

    function handleImportFailure (docName: string, error: any, reject: (reason?: any) => void): void {
      console.warn('IMPORT FAILED:', docName)
      console.log(error.stack)
      console.log('------------------------------------------------------------------')
      reject(error)
    }
  })
}

type DataProcessor = (
  client: TxOperations,
  uploadFile: FileUploader,
  data: Buffer,
  docMeta: DocumentMetadata,
  space: Ref<Teamspace>,
  parentMeta?: DocumentMetadata,
  documentMetaMap?: Map<string, DocumentMetadata>
) => Promise<void>

function getDataProcessor (fileMeta: FileMetadata, docMeta: DocumentMetadata): DataProcessor {
  if (fileMeta.isFolder && fileMeta.level === 1) {
    console.log('TEAMSPACE: ', docMeta.name)
    return skip
  }
  if (fileMeta.extension === MD_EXTENSION) {
    console.log('PAGE: ', docMeta.name)
    return importPageDocument
  }
  if (fileMeta.extension === CSV_EXTENSION && fileMeta.hasChildren) {
    console.log('DB FILE: ', docMeta.name)
    return createDBPageWithAttachments
  }
  if (fileMeta.extension === CSV_EXTENSION && /[\d\w]*_all$/.test(docMeta.notionId)) {
    console.log('DB FILE (ALL): ', docMeta.name)
    return importDBAttachment
  }
  if (!fileMeta.isFolder && fileMeta.extension !== '' && docMeta.notionParentId !== undefined) {
    console.log('ATTACHMENT: ', docMeta.name)
    return importAttachment
  }
  return skip
}

async function createDBPageWithAttachments (
  client: TxOperations,
  uploadFile: FileUploader,
  data: Buffer,
  docMeta: DocumentMetadata,
  space: Ref<Teamspace>,
  parentMeta?: DocumentMetadata,
  documentMetaMap?: Map<string, DocumentMetadata>
): Promise<void> {
  const pageId = docMeta.id as Ref<Document>
  const collabId = makeCollaborativeDoc(pageId, 'content')

  const parentId = parentMeta !== undefined ? (parentMeta.id as Ref<Document>) : document.ids.NoParent

  const lastRank = await getFirstRank(client, space, parentId)
  const rank = makeRank(lastRank, undefined)

  const object: AttachedData<Document> = {
    name: docMeta.name,
    content: collabId,
    attachments: 0,
    children: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0,
    rank
  }

  await client.addCollection(
    document.class.Document,
    space,
    parentId,
    document.class.Document,
    'children',
    object,
    pageId
  )

  const dbPage: DocumentMetadata = {
    id: pageId,
    notionParentId: docMeta.notionParentId,
    name: docMeta.name,
    notionId: docMeta.notionId
  }

  const attachment: DocumentMetadata = {
    id: generateId(),
    notionParentId: pageId,
    name: docMeta.name,
    notionId: docMeta.notionId,
    mimeType: docMeta.mimeType,
    size: docMeta.size
  }

  await importAttachment(client, uploadFile, data, attachment, space, dbPage)
}

async function importDBAttachment (
  client: TxOperations,
  uploadFile: FileUploader,
  data: Buffer,
  docMeta: DocumentMetadata,
  space: Ref<Teamspace>,
  parentMeta?: DocumentMetadata,
  documentMetaMap?: Map<string, DocumentMetadata>
): Promise<void> {
  const matched = docMeta.notionId.match(/([\d\w]*)_all$/)
  if (matched == null || matched.length < 2) {
    throw new Error('DB file not found: ' + docMeta.name)
  }

  const originalNotionId = matched[1]
  const dbPage = documentMetaMap?.get(originalNotionId)
  if (dbPage === undefined) {
    throw new Error('DB page metadata not found: ' + docMeta.name)
  }

  const attachment: DocumentMetadata = {
    id: docMeta.id,
    notionParentId: dbPage.id,
    name: docMeta.name,
    notionId: docMeta.notionId,
    mimeType: docMeta.mimeType,
    size: docMeta.size
  }
  await importAttachment(client, uploadFile, data, attachment, space, dbPage)
}

async function importAttachment (
  client: TxOperations,
  uploadFile: FileUploader,
  data: Buffer,
  docMeta: DocumentMetadata,
  space: Ref<Teamspace>,
  parentMeta?: DocumentMetadata,
  documentMetaMap?: Map<string, DocumentMetadata>
): Promise<void> {
  if (parentMeta === undefined) {
    throw new Error('Cannot import attachment without parent doc: ' + docMeta.id)
  }

  const size = docMeta.size ?? 0
  const type = docMeta.mimeType ?? DEFAULT_ATTACHMENT_MIME_TYPE

  const form = new FormData()
  const file = new File([new Blob([data])], docMeta.name)
  form.append('file', file, docMeta.id)
  form.append('type', type)
  form.append('size', size.toString())
  form.append('name', docMeta.name)
  form.append('id', docMeta.id)
  form.append('data', new Blob([data])) // ?

  await uploadFile(docMeta.id, form)

  const attachedData: AttachedData<Attachment> = {
    file: docMeta.id as Ref<Blob>,
    name: docMeta.name,
    lastModified: Date.now(),
    type,
    size
  }

  await client.addCollection(
    attachment.class.Attachment,
    space,
    parentMeta.id as Ref<Document>,
    document.class.Document,
    'attachments',
    attachedData,
    docMeta.id as Ref<Attachment>
  )
}

async function importPageDocument (
  client: TxOperations,
  uploadFile: FileUploader,
  data: Buffer,
  docMeta: DocumentMetadata,
  space: Ref<Teamspace>,
  parentMeta?: DocumentMetadata,
  documentMetaMap?: Map<string, DocumentMetadata>
): Promise<void> {
  const md = data.toString() ?? ''
  const json = parseMessageMarkdown(md ?? '', 'image://')
  if (documentMetaMap !== undefined) {
    preProcessMarkdown(json, documentMetaMap)
  }

  const id = docMeta.id as Ref<Document>
  const collabId = makeCollaborativeDoc(id, 'content')
  const yDoc = jsonToYDocNoSchema(json, 'content')
  const { documentId } = collaborativeDocParse(collabId)
  const buffer = yDocToBuffer(yDoc)

  const form = new FormData()
  const file = new File([new Blob([buffer])], docMeta.name)
  form.append('file', file, documentId)
  form.append('type', 'application/ydoc')
  form.append('size', buffer.length.toString())
  form.append('name', docMeta.name)
  form.append('id', docMeta.id)
  form.append('data', new Blob([buffer])) // ?

  await uploadFile(docMeta.id, form)

  const parentId = parentMeta?.id ?? document.ids.NoParent

  const lastRank = await getFirstRank(client, space, parentId as Ref<Document>)
  const rank = makeRank(lastRank, undefined)

  const attachedData: AttachedData<Document> = {
    name: docMeta.name,
    content: collabId,
    attachments: 0,
    children: 0,
    embeddings: 0,
    labels: 0,
    comments: 0,
    references: 0,
    rank
  }

  await client.addCollection(
    document.class.Document,
    space,
    parentId as Ref<Document>,
    document.class.Document,
    'children',
    attachedData,
    id
  )
}

function preProcessMarkdown (json: MarkupNode, documentMetaMap: Map<string, DocumentMetadata>): void {
  traverseNode(json, (node) => {
    if (node.type === MarkupNodeType.image) {
      const src = node.attrs?.src
      if (src !== undefined) {
        const notionId = getFileId('', src as string)
        const meta = documentMetaMap.get(notionId)
        if (meta !== undefined) {
          alterImageNode(node, meta)
        }
      }
    } else {
      traverseNodeMarks(node, (mark) => {
        if (mark.type === MarkupMarkType.link) {
          const href = mark.attrs.href
          switch (getLinkType(href)) {
            case NOTION_MD_LINK_TYPES.UNKNOWN:
            case NOTION_MD_LINK_TYPES.EXTERNAL_LINK: {
              console.log('skip this type of link: ', href)
              return
            }
            case NOTION_MD_LINK_TYPES.INTERNAL_LINK: {
              const notionId = getFileId('', href)
              const targetMeta = documentMetaMap.get(notionId)
              console.log('Target HULY page ID:', targetMeta?.id)
              if (targetMeta !== undefined) {
                alterInternalLinkNode(node, targetMeta)
              } else {
                console.warn('Linked page not found (outside of this import): ' + href)
              }
              return
            }
            case NOTION_MD_LINK_TYPES.ATTACHMENT: {
              const notionId = getFileId('', href)
              const attachmentMeta = documentMetaMap.get(notionId)
              if (attachmentMeta !== undefined) {
                console.log('Attachment found: ', attachmentMeta)
                alterAttachmentNode(node, attachmentMeta, href)
              } else {
                console.warn('Attachment not found: ', href)
              }
            }
          }
        }
      })
    }
    return true
  })
}

function getLinkType (href: string): NOTION_MD_LINK_TYPES {
  console.log('original link href: ' + href)
  if (isExternalLink(href)) return NOTION_MD_LINK_TYPES.EXTERNAL_LINK

  const notionId = extractNotionId(href)
  if (notionId !== null && notionId !== undefined && notionId !== '') {
    return NOTION_MD_LINK_TYPES.INTERNAL_LINK
  }

  const shortName = extractNameWoExtension(href)
  if (shortName !== undefined && shortName !== '') {
    return NOTION_MD_LINK_TYPES.ATTACHMENT
  }

  return NOTION_MD_LINK_TYPES.UNKNOWN
}

function alterAttachmentNode (node: MarkupNode, targetMeta: DocumentMetadata, href: string): void {
  node.type = MarkupNodeType.file
  node.attrs = {
    'file-id': targetMeta.id,
    'data-file-name': targetMeta.name,
    'data-file-size': targetMeta.size ?? 0,
    'data-file-type': targetMeta.mimeType ?? DEFAULT_ATTACHMENT_MIME_TYPE,
    'data-file-href': href
  }
}

function alterInternalLinkNode (node: MarkupNode, targetMeta: DocumentMetadata): void {
  node.type = MarkupNodeType.reference
  node.attrs = {
    id: targetMeta.id,
    label: targetMeta.name,
    objectclass: document.class.Document,
    text: '',
    content: ''
  }
}

function alterImageNode (node: MarkupNode, meta: DocumentMetadata): void {
  node.type = MarkupNodeType.image
  if (node.attrs !== undefined) {
    node.attrs['file-id'] = meta.id
    if (meta.mimeType !== undefined) {
      node.attrs['data-file-type'] = meta.mimeType
    }
  }
}

async function skip (...args: any): Promise<void> {
  const docMeta = args[5]
  console.warn('Unsupported entry type, skipping: ', docMeta)
}

function isExternalLink (href: any): boolean {
  return URL.canParse(href)
}

function extractNotionId (fileName: string): string | undefined {
  const decoded = decodeURI(fileName).trimEnd()
  const matched = decoded.match(/ ([\w\d]{32}(_all)?)(\.|$)/)
  return matched !== null && matched.length >= 2 ? matched[1] : undefined
}

function extractExtension (fileName: string): string {
  const decoded = decodeURI(fileName)
  return parse(decoded).ext.toLowerCase()
}

function extractNameWoExtension (fileName: string): string {
  const decoded = decodeURI(fileName)
  return parse(decoded).name
}

function extractOriginalName (fileName: string): string {
  const woExtension = extractNameWoExtension(fileName)
  const notionId = extractNotionId(woExtension)
  const nameOnly = notionId !== undefined ? woExtension.replace(notionId, '') : woExtension
  return nameOnly.trimEnd()
}

function getFileId (filePath: string, fileName: string): string {
  const notionId = extractNotionId(fileName)
  if (notionId !== '' && notionId !== undefined) {
    return notionId
  }
  const decodedPath = decodeURI(filePath)
  const decodedName = decodeURI(fileName)
  return join(basename(decodedPath), decodedName)
}

function getAncestorEntries (root: string, filePath: string): string[] {
  const relativePath = filePath.replace(root, '')
  const ancestors = relativePath.split('/')
  return ancestors
}

function getContentType (fileName: string): string | undefined {
  const mimeType = contentType(fileName)
  return mimeType !== false ? mimeType : undefined
}
