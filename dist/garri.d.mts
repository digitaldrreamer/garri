/**
 * garri — client-side native HTML to PDF.
 *
 * Hand-written rather than generated: the sources are classic scripts that
 * install globals, so there is nothing for a compiler to infer from.
 */

/** A problem the renderer met and reported instead of hiding. */
export interface Diagnostic {
  /** e.g. `PDF_FONT_SUBSTITUTED`, `PDF_VIEWPORT_MISMATCH`. */
  code: string;
  message: string;
  /** How many times this exact problem occurred. */
  count: number;
  detail?: unknown;
}

/** A font the PDF can embed. Bytes are fetched from `src`. */
export interface FontSpec {
  family: string;
  src: string;
  /** Defaults to 400. */
  weight?: number | string;
  /** Defaults to `"normal"`. */
  style?: string;
}

/** Page geometry, in millimetres. Overrides whatever `@page` says. */
export interface PageSpec {
  widthMm?: number;
  heightMm?: number;
  marginMm?: number;
}

export interface RenderOptions {
  /**
   * Faces to embed. Omit and every `@font-face` rule in the document is
   * discovered automatically. A family with no embeddable bytes falls back to
   * a standard PDF font and reports `PDF_FONT_SUBSTITUTED`.
   */
  fonts?: FontSpec[];
  /** Overrides the `@page` rule. */
  page?: PageSpec;
  /** Maximum pages per named-page run. Default 24. */
  columns?: number;
  /** Materialise `::before` / `::after` / counters. Default true. */
  generatedContent?: boolean;
  /**
   * `"fields"` (default) emits fillable AcroForm fields. `"flatten"` draws the
   * values as text, which is what a browser's own print does. `"none"` omits.
   */
  forms?: 'fields' | 'flatten' | 'none';
  /** Subset embedded fonts. Default true. */
  subset?: boolean;
  /** Called as each distinct diagnostic is first raised. */
  onDiagnostic?: (d: Diagnostic) => void;
  /** Only needed for the non-standalone builds. Defaults to `globalThis.PDFLib`. */
  pdfLib?: unknown;
  /** Only needed for the non-standalone builds. Defaults to `globalThis.fontkit`. */
  fontkit?: unknown;
}

export interface RenderStats {
  totalMs: number;
  runs: number;
  emitted: Record<string, number>;
  furniture?: string[];
}

export interface RenderResult {
  bytes: Uint8Array;
  pages: number;
  diagnostics: Diagnostic[];
  stats: RenderStats;
}

/** Content present in the DOM that this build does not write into the PDF. */
export interface UnhandledItem {
  code: string;
  count: number;
  /** A selector-ish hint at the first offender. */
  first: string | null;
}

/** Render `element` and its subtree to PDF bytes. */
export function render(element: Element, options?: RenderOptions): Promise<RenderResult>;

/** Render, and hand back a `application/pdf` Blob. */
export function renderToBlob(element: Element, options?: RenderOptions): Promise<Blob>;

/** Render and trigger a download. Resolves with the render result. */
export function download(
  element: Element,
  filename?: string,
  options?: RenderOptions,
): Promise<RenderResult>;

/** Render and open the PDF in a new tab. Resolves with the render result. */
export function open(element: Element, options?: RenderOptions): Promise<RenderResult>;

/**
 * Every `@font-face` the document declares, with an absolute URL for its bytes.
 * Cross-origin stylesheets cannot be read and are skipped.
 */
export function discoverFonts(): FontSpec[];

/** What `render` would report as not emitted, without rendering. */
export function unhandledContent(element: Element, hasEmitters?: boolean): UnhandledItem[];

// --- lower-level pieces, for callers driving the pipeline themselves --------
// Deliberately loosely typed: these are internal shapes that may change inside
// 0.x, and pretending otherwise would be worse than saying so.

export const extractTextRuns: (root: Element) => { runs: unknown[]; stats: unknown };
export const materializeGenerated: (root: Element) => unknown;
export const FontRegistry: new () => unknown;
export const furniture: Record<string, unknown>;
export const emit: Record<string, unknown>;

export const version: string;

declare const api: {
  render: typeof render;
  renderToBlob: typeof renderToBlob;
  download: typeof download;
  open: typeof open;
  discoverFonts: typeof discoverFonts;
  unhandledContent: typeof unhandledContent;
  extractTextRuns: typeof extractTextRuns;
  materializeGenerated: typeof materializeGenerated;
  FontRegistry: typeof FontRegistry;
  furniture: typeof furniture;
  emit: typeof emit;
  version: string;
};

export default api;

declare global {
  // eslint-disable-next-line no-var
  var Garri: typeof api;
  // eslint-disable-next-line no-var
  var PeeDeeEff: typeof api;
}
