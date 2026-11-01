export { getEmbedder, embedderStatus, EMBEDDING_DIMENSIONS } from "./embeddings";
export type { Embedder, EmbedderStatus } from "./embeddings";
export { chunkText } from "./chunk";
export {
  ingestDocument,
  listDocuments,
  getDocument,
  deleteDocument,
  deleteDocumentsBySource,
  listCollections,
} from "./ingest";
export type {
  IngestInput,
  IngestResult,
  DocumentSummary,
  DocumentDetail,
} from "./ingest";
export {
  registerSource,
  registerSourceFamily,
  getSource,
  listSources,
  syncSource,
  describeSync,
  confluenceSource,
  pmToolSource,
  teamsNotesSource,
  githubDocsSources,
  TEAMS_NOTES_COLLECTION,
  GITHUB_TOKEN_ENV,
} from "./sources";
export type {
  KnowledgeSource,
  SourceDocument,
  SourceItem,
  SourceListing,
  SourceInfo,
  SyncResult,
} from "./sources";
export { sharepointFolderSources, loadSharepointFolders, folderSlug, SHAREPOINT_SYNC_MINUTES_DEFAULT } from "./sharepoint";
export { retrieveChunks, chunksToContext } from "./retrieve";
export { accessPredicate, collectionReadable } from "./access";
export type { RetrievedChunk, RetrieveOptions } from "./retrieve";
