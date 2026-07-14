import { invoke } from '@tauri-apps/api/core';
import type { DirEntry } from '../types';

/** Tauri ランタイム上で動作しているかどうか(ブラウザプレビュー時は false) */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function requireTauri(): void {
  if (!isTauri()) {
    throw new Error('not running in Tauri');
  }
}

/** Rust が内容の世代を表す不透明な値。比較以外の用途には使わない。 */
export type FileRevision = string;

export interface FileReadResult {
  content: string;
  revision: FileRevision;
  hasBom: boolean;
}

export interface WriteFileOptions {
  /** 読み込み時の世代。現在のディスク世代と異なる場合は Rust 側で競合として拒否する。 */
  expectedRevision?: FileRevision;
  /** UTF-8 BOM を読み込み時の状態のまま維持する。 */
  hasBom?: boolean;
}

export interface FileWriteResult {
  revision: FileRevision;
}

export interface PathResult {
  path: string;
}

export async function setWorkspaceRoot(path: string): Promise<string> {
  requireTauri();
  return invoke<string>('set_workspace_root', { path });
}

export async function readDir(path: string): Promise<DirEntry[]> {
  requireTauri();
  return invoke<DirEntry[]>('read_dir', { path });
}

export async function readFile(path: string): Promise<FileReadResult> {
  requireTauri();
  return invoke<FileReadResult>('read_file', { path });
}

export async function writeFile(
  path: string,
  contents: string,
  options: WriteFileOptions = {},
): Promise<FileWriteResult> {
  requireTauri();
  return invoke<FileWriteResult>('write_file', {
    path,
    contents,
    expectedRevision: options.expectedRevision,
    hasBom: options.hasBom,
  });
}

/** 空ファイルを新規作成する。既存ファイルがある場合は Rust 側で拒否される。 */
export async function createFile(path: string): Promise<FileWriteResult> {
  requireTauri();
  return invoke<FileWriteResult>('create_file', { path });
}

export async function createDir(path: string): Promise<PathResult> {
  requireTauri();
  return invoke<PathResult>('create_dir', { path });
}

export async function renamePath(path: string, newPath: string): Promise<PathResult> {
  requireTauri();
  return invoke<PathResult>('rename_path', { path, newPath });
}

export async function deleteToTrash(path: string): Promise<void> {
  requireTauri();
  await invoke<void>('delete_to_trash', { path });
}
