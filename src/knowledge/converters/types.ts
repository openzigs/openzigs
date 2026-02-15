/**
 * Shared types for the file converter pipeline.
 *
 * Every converter takes a file path and returns extracted text content
 * plus metadata about the conversion.
 */

/** Result of converting a file to plain text / markdown. */
export type ConversionResult = {
  /** Extracted text content (plain text or markdown). */
  text: string;
  /** Whether the conversion was successful. */
  success: boolean;
  /** Human-readable converter name (e.g. "pdf-parse", "mammoth"). */
  converter: string;
  /** Optional metadata extracted during conversion. */
  metadata?: Record<string, unknown>;
  /** Error message if conversion failed. */
  error?: string;
};

/** A converter function: takes a file path, returns extracted text. */
export type FileConverter = (filePath: string) => Promise<ConversionResult>;

/** Describes a registered converter with its supported extensions. */
export type ConverterRegistration = {
  /** Human-readable name. */
  name: string;
  /** File extensions this converter handles (e.g. [".pdf"]). */
  extensions: string[];
  /** Whether the converter's runtime dependencies are available. */
  available: boolean;
  /** The converter function. */
  convert: FileConverter;
  /** Why the converter is unavailable (missing binary, etc.). */
  unavailableReason?: string;
};
