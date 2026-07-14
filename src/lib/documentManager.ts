import { loader, type Monaco } from '@monaco-editor/react';
import type { IDisposable, editor } from 'monaco-editor';
import type { FileRevision } from './fs';

/** Monaco model の寿命を識別する値。ファイルパスの再オープンと区別するために使う。 */
export type DocumentId = number;

export interface DocumentCreateOptions {
  path: string;
  content: string;
  language: string;
  revision: FileRevision;
  hasBom: boolean;
  /** workspace の切替後に古い read 結果から model を作らないためのガード。 */
  isCurrent?: () => boolean;
}

export interface DocumentInfo {
  documentId: DocumentId;
  path: string;
  modelUri: string;
  language: string;
  revision: FileRevision;
  hasBom: boolean;
  dirty: boolean;
  savedAlternativeVersionId: number;
}

export interface DocumentSaveSnapshot {
  documentId: DocumentId;
  path: string;
  contents: string;
  alternativeVersionId: number;
  revision: FileRevision;
  hasBom: boolean;
}

export interface DocumentChange {
  documentId: DocumentId;
  path: string;
  dirty: boolean;
}

interface ManagedDocument extends DocumentInfo {
  model: editor.ITextModel;
  contentChangeDisposable: IDisposable;
}

type DocumentChangeListener = (change: DocumentChange) => void;

/**
 * Monaco model と保存基準を一元管理する。
 *
 * Zustand には本文を置かず、ここにある ITextModel を唯一の本文 source of truth にする。
 */
class DocumentManager {
  private readonly documents = new Map<string, ManagedDocument>();
  private readonly listeners = new Set<DocumentChangeListener>();
  private monacoPromise: Promise<Monaco> | null = null;
  private monaco: Monaco | null = null;
  private nextDocumentId = 1;

  subscribe(listener: DocumentChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async createOrGetDocument(options: DocumentCreateOptions): Promise<DocumentInfo | null> {
    if (options.isCurrent?.() === false) return null;

    const existing = this.documents.get(options.path);
    if (existing && !existing.model.isDisposed()) {
      return this.toInfo(existing);
    }
    if (existing) this.disposeDocument(options.path);

    const monaco = await this.getMonaco();
    if (options.isCurrent?.() === false) return null;

    // loader.init() を待つ間に別の open 要求が同じ model を作った場合は再利用する。
    const documentAfterLoad = this.documents.get(options.path);
    if (documentAfterLoad && !documentAfterLoad.model.isDisposed()) {
      return this.toInfo(documentAfterLoad);
    }

    const modelUri = monaco.Uri.file(options.path).toString();
    const uri = monaco.Uri.parse(modelUri);
    const unownedModel = monaco.editor.getModel(uri);
    if (unownedModel) {
      // @monaco-editor/react が先に作った同 URI の空モデルを残すと、ディスク本文が失われる。
      unownedModel.dispose();
    }

    const model = monaco.editor.createModel(options.content, options.language, uri);
    const document: ManagedDocument = {
      documentId: this.nextDocumentId++,
      path: options.path,
      modelUri,
      language: options.language,
      revision: options.revision,
      hasBom: options.hasBom,
      dirty: false,
      savedAlternativeVersionId: model.getAlternativeVersionId(),
      model,
      contentChangeDisposable: { dispose() {} },
    };

    document.contentChangeDisposable = model.onDidChangeContent(() => {
      this.refreshDirty(document);
    });
    this.documents.set(options.path, document);
    return this.toInfo(document);
  }

  getDocument(path: string): DocumentInfo | null {
    const document = this.documents.get(path);
    if (!document || document.model.isDisposed()) return null;
    return this.toInfo(document);
  }

  getModel(path: string): editor.ITextModel | null {
    const document = this.documents.get(path);
    if (!document || document.model.isDisposed()) return null;
    return document.model;
  }

  captureSaveSnapshot(path: string): DocumentSaveSnapshot | null {
    const document = this.documents.get(path);
    if (!document || document.model.isDisposed()) return null;

    return {
      documentId: document.documentId,
      path: document.path,
      contents: document.model.getValue(),
      alternativeVersionId: document.model.getAlternativeVersionId(),
      revision: document.revision,
      hasBom: document.hasBom,
    };
  }

  /**
   * 書き込み済みの version を保存基準にする。保存中に編集された場合も現在の model と
   * snapshot の alternativeVersionId が異なるため、dirty は true のままになる。
   */
  markSaved(snapshot: DocumentSaveSnapshot, revision: FileRevision): DocumentInfo | null {
    const document = this.documents.get(snapshot.path);
    if (!document || document.documentId !== snapshot.documentId || document.model.isDisposed()) {
      return null;
    }

    document.savedAlternativeVersionId = snapshot.alternativeVersionId;
    document.revision = revision;
    document.hasBom = snapshot.hasBom;
    this.refreshDirty(document);
    return this.toInfo(document);
  }

  /**
   * Rename keeps the current Monaco model (and therefore its undo history and unsaved text)
   * alive. Monaco cannot change an existing model URI, so `modelUri` intentionally remains
   * stable while the document's filesystem path changes.
   */
  renameDocument(path: string, newPath: string, language: string): DocumentInfo | null {
    const document = this.documents.get(path);
    if (!document || document.model.isDisposed()) return null;

    const existing = this.documents.get(newPath);
    if (existing && existing !== document) {
      throw new Error('名前変更後のパスはすでにエディタで開かれています');
    }

    this.documents.delete(path);
    document.path = newPath;
    document.language = language;
    if (this.monaco) {
      this.monaco.editor.setModelLanguage(document.model, language);
    }
    this.documents.set(newPath, document);
    return this.toInfo(document);
  }

  disposeDocument(path: string): void {
    const document = this.documents.get(path);
    if (!document) return;

    this.documents.delete(path);
    document.contentChangeDisposable.dispose();
    if (!document.model.isDisposed()) {
      document.model.dispose();
    }
  }

  disposeAllDocuments(): void {
    for (const path of Array.from(this.documents.keys())) {
      this.disposeDocument(path);
    }
  }

  private async getMonaco(): Promise<Monaco> {
    const pending = this.monacoPromise ?? loader.init();
    this.monacoPromise = pending;
    try {
      const monaco = await pending;
      this.monaco = monaco;
      return monaco;
    } catch (error) {
      if (this.monacoPromise === pending) {
        this.monacoPromise = null;
      }
      throw error;
    }
  }

  private refreshDirty(document: ManagedDocument): void {
    if (this.documents.get(document.path) !== document || document.model.isDisposed()) return;

    const dirty = document.model.getAlternativeVersionId() !== document.savedAlternativeVersionId;
    if (document.dirty === dirty) return;

    document.dirty = dirty;
    const change: DocumentChange = {
      documentId: document.documentId,
      path: document.path,
      dirty,
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        // 編集イベントは UI の一部が失敗しても Monaco 自体を止めない。
        console.error('document change listener failed:', error);
      }
    }
  }

  private toInfo(document: ManagedDocument): DocumentInfo {
    const {
      documentId,
      path,
      modelUri,
      language,
      revision,
      hasBom,
      dirty,
      savedAlternativeVersionId,
    } = document;
    return { documentId, path, modelUri, language, revision, hasBom, dirty, savedAlternativeVersionId };
  }
}

export const documentManager = new DocumentManager();
