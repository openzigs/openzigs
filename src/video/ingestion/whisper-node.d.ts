declare module "whisper-node" {
  interface WhisperOptions {
    language?: string;
    word_timestamps?: boolean;
  }
  interface WhisperResult {
    start: string;
    end: string;
    speech: string;
  }
  function whisper(
    filePath: string,
    options?: { modelName?: string; whisperOptions?: WhisperOptions },
  ): Promise<WhisperResult[]>;
  export default whisper;
}
