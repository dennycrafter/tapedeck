"use client";

/**
 * The Add window's Upload tab (T15): the Upload button opens the file
 * picker (several files at once; on the iPhone it opens Files), and every
 * file gets a row with its own progress bar and outcome. On PC a dashed
 * area invites dropping files or folders (they can land anywhere on the
 * page) and offers "Choose a folder". The queue itself is UploadsProvider,
 * so rows survive closing the window.
 */
import { useRef } from "react";
import { MAX_UPLOAD_MB, titleFromFileName, UPLOAD_ACCEPT } from "../../lib/upload-rules";
import { isFinished, useUploads, type UploadItem } from "./UploadsProvider";
import { UploadIcon } from "./icons";
import { BTN_QUIET, FOCUS } from "./ui";

const FORMATS_HINT = `MP3, M4A, WAV or FLAC, up to ${MAX_UPLOAD_MB} MB each.`;

// React has no prop for it; the browser reads it as "pick a folder".
const FOLDER_PICKER = { webkitdirectory: "" } as Record<string, string>;

function statusText(item: UploadItem): string {
  switch (item.stage) {
    case "queued":
      return "Waiting";
    case "reading":
      return "Reading";
    case "uploading":
      return `${Math.round(item.progress * 100)}%`;
    case "saving":
      return "Saving";
    case "added":
      return "Added";
    case "already":
      return "Already in your library";
    case "error":
      return "Failed";
  }
}

function statusClass(item: UploadItem): string {
  if (item.stage === "added") return "text-ok";
  if (item.stage === "error") return "text-bad";
  return "text-muted";
}

function UploadRow({ item }: { item: UploadItem }) {
  const name = item.title ?? titleFromFileName(item.fileName);
  // The file name only adds something when the tags gave another title.
  const showFileName = item.title !== null && item.title !== titleFromFileName(item.fileName);
  const percent = item.stage === "saving" ? 100 : Math.round(item.progress * 100);
  return (
    <li className="px-3 py-2" data-testid="upload-item" data-stage={item.stage}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-sm" data-testid="upload-item-name">
          {name}
        </span>
        <span className={`shrink-0 text-xs tabular-nums ${statusClass(item)}`} data-testid="upload-item-status">
          {statusText(item)}
        </span>
      </div>
      {showFileName && <p className="truncate text-xs text-muted">{item.fileName}</p>}
      {!isFinished(item) && (
        <div
          role="progressbar"
          aria-label={`Uploading ${name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="mt-1.5 h-1 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-silver transition-[width] duration-200" style={{ width: `${percent}%` }} />
        </div>
      )}
      {item.stage === "error" && (
        <p className="mt-0.5 text-xs text-bad" data-testid="upload-item-error">
          {item.message}
        </p>
      )}
    </li>
  );
}

export function UploadPanel() {
  const { items, addFiles, addFolder, clearFinished } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const finished = items.filter(isFinished).length;

  return (
    <div data-testid="upload-panel">
      {/* PC: where files can be dropped (anywhere on the page works too). */}
      <div className="mt-3 hidden flex-col items-center justify-center gap-1 rounded-btn border border-dashed border-line bg-bg px-4 py-7 text-center lg:flex">
        <UploadIcon className="text-muted" />
        <p className="text-sm text-silver">Drop songs or folders here</p>
        <p className="text-xs text-muted">{FORMATS_HINT}</p>
        <button
          type="button"
          onClick={() => folderInput.current?.click()}
          className={`${BTN_QUIET} mt-1`}
          data-testid="upload-choose-folder"
        >
          Choose a folder
        </button>
      </div>
      <p className="mt-3 text-sm text-muted lg:hidden">{FORMATS_HINT} You can pick several at once.</p>
      <input
        ref={input}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-input"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // Clear it so picking the same file again still fires a change.
          event.target.value = "";
          if (picked.length > 0) addFiles(picked);
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        {...FOLDER_PICKER}
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="upload-folder-input"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) addFolder(picked);
        }}
      />
      <button
        type="button"
        autoFocus
        onClick={() => input.current?.click()}
        data-testid="upload-choose"
        className={
          // The same weight and shape as the Paste links tab's Add button. It
          // is focused when the tab opens, so the outline shows only for the
          // keyboard (FOCUS), not after a tap or click.
          `mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-btn bg-accent px-3 py-2 font-medium text-bg hover:bg-accent-ink ${FOCUS}`
        }
      >
        <UploadIcon width={18} height={18} />
        Upload
      </button>
      {items.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Uploads</p>
            {finished > 0 && (
              <button type="button" onClick={clearFinished} className={BTN_QUIET} data-testid="upload-clear">
                Clear finished
              </button>
            )}
          </div>
          <ul
            className="mt-1 flex max-h-64 flex-col divide-y divide-line overflow-y-auto rounded-btn border border-line bg-bg"
            data-testid="upload-list"
            aria-live="polite"
          >
            {items.map((item) => (
              <UploadRow key={item.key} item={item} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
