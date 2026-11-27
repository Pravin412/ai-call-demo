import { IsIn, IsOptional } from 'class-validator';

// Languages the Colab service accepts (its allowed_languages list; all are XTTS-v2 languages)
export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'hi', 'ja', 'zh-cn'];

// Text fields of the multipart form; the audio files arrive via @UploadedFiles()
export class ProcessVoiceDto {
  @IsOptional()
  @IsIn(SUPPORTED_LANGUAGES)
  language?: string;
}
