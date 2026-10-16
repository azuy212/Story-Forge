import { readFile } from 'fs/promises';

export class PromptReader {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string[]> {
    const content = await readFile(this.filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  }
}
