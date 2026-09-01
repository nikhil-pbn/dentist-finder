/**
 * Browser download plumbing, shared by the export writers.
 *
 * Client-only: it touches `document` and `URL.createObjectURL`.
 */

/** Hands the browser a file built in memory. Never hits the network. */
export function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoking immediately is safe: the click has already started the download.
  URL.revokeObjectURL(url);
}
