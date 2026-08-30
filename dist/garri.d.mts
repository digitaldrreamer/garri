/**
 * garri — client-side native HTML to PDF.
 *
 * Hand-written: the sources are classic scripts that install globals, so there
 * is nothing for a compiler to infer from. Every shape below was read off a
 * live run rather than inferred from the source, because this project has
 * three recorded cases of an extractor's shape being assumed and assumed wrong.
 *
 * @remarks
 * Stability within `0.x`: the top-level rendering API (`render`, `download`,
 * `renderToBlob`, `open`) is settled. The lower-level pieces — `extractTextRuns`,
 * `materializeGenerated`, `FontRegistry`, `furniture`, `emit` — are typed
 * precisely but may still change; anything that changes will be marked
 * `@deprecated` for at least one minor release before it moves or goes.
 */

// ---------------------------------------------------------------- shared ---

/** A rectangle in CSS pixels, relative to the viewport. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A box in CSS pixels: origin plus size. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A problem the renderer met and reported instead of hiding. */
export interface Diagnostic {
  /** e.g. `PDF_FONT_SUBSTITUTED`, `PDF_VIEWPORT_MISMATCH`. */
  code: string;
  message: string;
  /** How many times this exact problem occurred. */
  count: number;
  detail?: unknown;
}

// ------------------------------------------------------------ public API ---

/** A font the PDF can embed. Bytes are fetched from `src`. */
export interface FontSpec {
  family: string;
  src: string;
  /** Defaults to 400. */
  weight?: number | string;
  /** Defaults to `"normal"`. */
  style?: string;
}

/** Page geometry in millimetres. Overrides whatever `@page` says. */
export interface PageSpec {
  widthMm?: number;
  heightMm?: number;
  marginMm?: number;
}

/** How form controls are represented in the PDF. */
export type FormsMode = 'fields' | 'flatten' | 'none';

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
  /** Materialise `::before` / `::after` / counters. Default `true`. */
  generatedContent?: boolean;
  /**
   * `"fields"` (default) emits fillable AcroForm fields. `"flatten"` draws the
   * values as text, which is what a browser's own print does. `"none"` omits.
   */
  forms?: FormsMode;
  /** Subset embedded fonts. Default `true`. */
  subset?: boolean;
  /** Called as each distinct diagnostic is first raised. */
  onDiagnostic?: (d: Diagnostic) => void;
  /** Only needed for the non-standalone builds. Defaults to `globalThis.PDFLib`. */
  pdfLib?: unknown;
  /** Only needed for the non-standalone builds. Defaults to `globalThis.fontkit`. */
  fontkit?: unknown;
}

/** Counts of what was actually written into the PDF. */
export interface EmittedCounts {
  backgrounds: number;
  gradients: number;
  bgImages: number;
  borders: number;
  images: number;
  svg: number;
  links: number;
  shadows: number;
  blends: number;
  canvases: number;
  formFields: number;
  formsFlattened: number;
  clips?: number;
  dashedSides?: number;
}

export interface RenderStats {
  totalMs: number;
  /** Total text runs drawn across every page. */
  runs: number;
  emitted: EmittedCounts;
  /** Per page, the furniture drawn on it, as `kind:count` strings. */
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
  /** A selector-ish hint at the first offender, or `null` if none was seen. */
  first: string | null;
}

/** Render `element` and its subtree to PDF bytes. */
export function render(element: Element, options?: RenderOptions): Promise<RenderResult>;

/** Render, and hand back an `application/pdf` Blob. */
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

/**
 * What `render` would report as not emitted, without rendering.
 * @param hasEmitters - defaults to whether `src/pdf/emit.js` is loaded.
 */
export function unhandledContent(element: Element, hasEmitters?: boolean): UnhandledItem[];

// ----------------------------------------------------------- text runs ----

/** One word, positioned by the browser's own measurement. */
export interface Word {
  text: string;
  /** Viewport x of the word's left edge, in CSS pixels. */
  left: number;
  /** Viewport x of the word's right edge, in CSS pixels. */
  right: number;
  /**
   * Each character's own measured extent, in document order. A word whose
   * characters need different faces — Latin from the declared family, CJK from
   * a fallback — is split at those boundaries and each segment drawn at its own
   * `left`, rather than at an advance computed from the PDF font.
   */
  chars: WordChar[];
}

/** One character's measured horizontal extent within a {@link Word}. */
export interface WordChar {
  ch: string;
  /** Viewport x of this character's left edge, in CSS pixels. */
  left: number;
  /** Viewport x of this character's right edge, in CSS pixels. */
  right: number;
}

/**
 * Three candidate baselines. `topPlusFontAscent` is the correct one — confirmed
 * against Chromium's own output and, in Blink source, platform-invariant. The
 * others are kept because the comparison is what established that.
 */
export interface BaselineCandidates {
  topPlusFontAscent: number;
  topPlusActualAscent: number;
  bottomMinusFontDescent: number;
}

/** Resolved font properties for a run, as the browser computed them. */
export interface RunFont {
  /** The full computed `font-family` list, not a resolved face. */
  family: string;
  /** In CSS pixels. */
  size: number;
  weight: string;
  style: string;
  lineHeight: string;
  letterSpacing: string;
  wordSpacing: string;
  /** From `measureText().fontBoundingBoxAscent`. */
  ascent: number;
  descent: number;
}

/** One line fragment. Chromium's text items are line fragments, not nodes. */
export interface TextRun {
  text: string;
  words: Word[];
  /** The line fragment's own rectangle. */
  rect: Rect;
  baselineCandidates: BaselineCandidates;
  font: RunFont;
  /** Computed `color`, as a CSS colour string. */
  color: string;
  /** `#id` when the element has one, else its tag name. */
  selector: string;
}

export interface ExtractStats {
  runCount: number;
  /** How many per-character Range probes were needed. */
  charProbes: number;
  extractMs: number;
}

export interface TextExtraction {
  runs: TextRun[];
  stats: ExtractStats;
}

/** Recover every line fragment under `root`, with geometry. */
export const extractTextRuns: (root: Element) => TextExtraction;

// --------------------------------------------------- generated content ----

/** A list marker recovered while materialising generated content. */
export interface Marker {
  kind: string;
  text?: string;
  shape?: string;
  /** Viewport x of the marker's right edge. */
  right: number;
}

export interface MaterializeResult {
  markers: Marker[];
  /** How many pseudo-elements were materialised. */
  count: number;
  diagnostics: Diagnostic[];
}

/**
 * Turn `::before` / `::after` / counters into real inline elements so the text
 * pipeline can measure them. Mutates the DOM.
 */
export const materializeGenerated: (root: Element) => MaterializeResult;

// --------------------------------------------------------- font registry ---

/** A registered face, once `load()` has fetched its bytes. */
export interface RegisteredFace {
  family: string;
  weight: number | string;
  style: string;
  src: string;
  /** `null` until `load()` resolves. */
  bytes: ArrayBuffer | null;
  /** The fontkit font object, or `null` if the bytes could not be read. */
  fk: unknown | null;
}

/** The subset of `getComputedStyle` output face lookup needs. */
export interface FontQuery {
  fontFamily: string;
  fontWeight: number | string;
  fontStyle: string;
}

/** One stretch of text backed by a single face that covers every character. */
export interface ShapedRun {
  text: string;
  face: RegisteredFace | null;
}

/**
 * Fonts registered explicitly, with coverage enforced per code point.
 * Metrics come from the primary family; glyphs from the first family that
 * covers the character.
 */
export declare class FontRegistry {
  faces: RegisteredFace[];
  diagnostics: Diagnostic[];
  register(spec: FontSpec): this;
  /** Fetches every registered face's bytes. */
  load(): Promise<this>;
  face(family: string, weight: number | string, style: string): RegisteredFace | null;
  covers(face: RegisteredFace, codePoint: number): boolean;
  /**
   * Best face for a computed style, walking its family list. This answers the
   * METRICS question: Chromium positions the inline box from the primary
   * family's metrics even when the glyphs come from a fallback. It does not
   * check coverage — use {@link FontRegistry.faceForCodePoint} for that.
   */
  metricsFace(cs: FontQuery): RegisteredFace | null;
  /**
   * The face that will actually DRAW this code point, or `null` if no declared
   * family covers it. This is the GLYPH question, and the two are deliberately
   * different resolutions.
   */
  faceForCodePoint(codePoint: number, cs: FontQuery): RegisteredFace | null;
  shapeRuns(text: string, cs: FontQuery): ShapedRun[];
  usedFaces(): RegisteredFace[];
  report(): unknown;
}

// -------------------------------------------------------------- furniture --

/** One `@page` margin box, e.g. `@top-center`. */
export interface MarginBox {
  kind: 'margin-box';
  /** e.g. `"top-center"`, `"bottom-right"`. */
  slot: string;
  /** The raw `content` value, or `null` for an unsupported slot. */
  content: string | null;
  font?: {
    family: string;
    /** `null` when the rule sets no size; the caller falls back to the default. */
    size: number | null;
    weight: string;
    style: string;
  };
  color?: string;
  unsupportedSlot: boolean;
}

/** One parsed `@page` rule. */
export interface PageRule {
  /** `""` for the default rule, else the page name. */
  name: string;
  /** The raw `size` value, e.g. `"210mm 297mm"`. */
  size: string;
  /** The raw `margin` value. */
  margin: string;
  boxes: MarginBox[];
}

/** A run of elements sharing one page context. */
export interface PageRun {
  /** `""` for the default page context. */
  page: string;
  elements: Element[];
}

export interface FixedFurniture {
  kind: 'fixed';
  el: Element;
  rect: Box;
}

export interface TableFurniture {
  kind: 'table';
  table: Element;
  head: Element | null;
  foot: Element | null;
  headH: number;
  footH: number;
}

export interface FurnitureSet {
  fixed: FixedFurniture[];
  tables: TableFurniture[];
}

/** One furniture instance to draw on a given page. */
export interface EmittedFurniture {
  kind: 'fixed' | 'table-header' | 'table-footer';
  el: Element;
  rect?: Box;
  /** The row this header sits above, or footer below. */
  anchor?: Element;
  height?: number;
  texts: string[];
}

export interface ReserveResult {
  /** How many measure passes convergence took. */
  passes: number;
  /** How many spacer rows were inserted. */
  spacers: number;
}

export interface MarginPlacement {
  /** Viewport y of the text baseline. */
  baseline: number;
  /** Viewport x of the content box's left and right edges. */
  contentL: number;
  contentR: number;
  align: 'left' | 'center' | 'right';
}

export interface ResolvedMarginContent {
  text: string;
  /** The first token that could not be resolved, or `null`. */
  unresolved: string | null;
}

/** Page geometry a margin box is placed against, in CSS pixels. */
export interface PageGeometry {
  w: number;
  h: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
}

/** Ascent and descent of the margin box's font, in CSS pixels. */
export interface FontMetrics {
  ascent: number;
  descent: number;
}

/**
 * The furniture layer: what must independently appear on each physical page,
 * as opposed to flow content, which the pagination oracle answers for.
 */
export interface Furniture {
  /** Fixed elements and repeating table sections under `root`. */
  identify(root: Element): FurnitureSet;
  /** Remove furniture from the flow about to be measured. Returns a restore fn. */
  detach(furniture: FurnitureSet): () => void;
  /**
   * Insert spacers so page assignment accounts for repeated headers.
   * Iterates until the set of column-leading rows stops moving.
   * @param measureColumns - returns an element to column-index mapping
   */
  reserve(
    furniture: FurnitureSet,
    measureColumns: () => (el: Element) => number | null,
    maxPasses?: number,
  ): ReserveResult;
  /** What to draw on each page, indexed by column. */
  emit(
    furniture: FurnitureSet,
    columnOf: (el: Element) => number | null,
    pageCount: number,
  ): EmittedFurniture[][];
  clearSpacers(): void;
  /** The attribute marking an inserted spacer row. */
  SPACER_ATTR: string;
  /** Margin boxes declared on the default `@page` rule. */
  marginBoxes(): MarginBox[];
  resolveMarginContent(
    content: string | null,
    pageNumber: number,
    pageCount: number,
  ): ResolvedMarginContent;
  marginBoxPlacement(
    slot: string,
    page: PageGeometry,
    metrics: FontMetrics,
  ): MarginPlacement;
  /** Every `@page` rule in the CSSOM, keyed by name (`""` for the default). */
  pageRules(): Map<string, PageRule>;
  /** Split `root` into runs of uniform page geometry. */
  segmentByPage(root: Element): PageRun[];
  /**
   * The cascade for one page: default, then spread side, then `:first`, then
   * the named rule. These merge per margin slot rather than one winning.
   */
  rulesForPage(
    rules: Map<string, PageRule>,
    pageName: string,
    pageIndex: number,
  ): Pick<PageRule, 'size' | 'margin' | 'boxes'>;
  /** Turn forced page breaks into column breaks for the oracle. Mutates styles. */
  translatePageBreaks(root: Element): void;
  MARGIN_BOX_DEFAULT_FONT: {
    size: number;
    family: string;
    weight: string;
    style: string;
  };
}

export const furniture: Furniture;

// ----------------------------------------------------------------- emit ----

/** Maps a viewport-pixel point onto the current page, in PDF points. */
export interface PageTransform {
  /** Points per CSS pixel: 72/96. */
  PT: number;
  x(viewportX: number): number;
  y(viewportY: number): number;
}

/** Per-document emitter state: shared shading and ExtGState resources. */
export interface EmitContext {
  doc: unknown;
  raw(page: unknown, operators: string): void;
  addShading(page: unknown, dict: unknown): string;
  alphaState(page: unknown, fillAlpha: number, strokeAlpha?: number, blend?: string | null): string;
  stopsToFunction(stops: Array<{ color: unknown; pos: number }>): unknown;
}

/**
 * Writers that turn extractor output into PDF operators. Everything works in
 * viewport pixels and is mapped by the `xf` transform, because in a paginated
 * document the same element may land in any column.
 */
export interface Emit {
  createContext(doc: unknown, pdfLib: unknown): EmitContext;
  emitPaint(page: unknown, items: unknown[], ctx: EmitContext, xf: PageTransform, opts?: unknown): Promise<Record<string, number>>;
  emitImages(page: unknown, images: unknown[], ctx: EmitContext, xf: PageTransform, opts?: unknown): Promise<Record<string, number>>;
  emitCanvas(page: unknown, canvases: unknown[], ctx: EmitContext, xf: PageTransform, opts?: unknown): Promise<Record<string, number>>;
  emitSvg(page: unknown, shapes: unknown[], ctx: EmitContext, xf: PageTransform): Record<string, number>;
  emitLinks(page: unknown, links: unknown[], ctx: EmitContext, xf: PageTransform): { links: number };
  emitForms(page: unknown, fields: unknown[], ctx: EmitContext, xf: PageTransform, opts?: unknown): Record<string, number>;
  /** A rounded rectangle as PDF path operators, in page space. */
  roundRectOps(x: number, y: number, w: number, h: number, r: Record<string, [number, number]>): string[];
  circleOps(cx: number, cy: number, r: number): string[];
  boxOps(xf: PageTransform, box: Box, radii: Record<string, [number, number]> | null): string[];
  parseShadow(css: string): {
    color: string; dx: number; dy: number; blur: number; spread: number; inset: boolean;
  };
  shadowImage(doc: unknown, item: unknown, scale?: number): Promise<{
    img: unknown; left: number; top: number; w: number; h: number;
  } | null>;
  /** CSS `mix-blend-mode` to PDF `/BM` names. */
  BLEND: Record<string, string>;
}

export const emit: Emit;

// -------------------------------------------------------------- version ----

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
  furniture: Furniture;
  emit: Emit;
  version: string;
};

export default api;

declare global {
  // eslint-disable-next-line no-var
  var Garri: typeof api;
  /** Alias kept for script tags written before the package was renamed. */
  // eslint-disable-next-line no-var
  var PeeDeeEff: typeof api;
}
