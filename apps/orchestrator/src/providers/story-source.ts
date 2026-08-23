export type StorySourceRecord = {
  rowNumber: number;
  category: string;
  workingTitle: string;
  narrationDraft: string;
};

export interface StorySource {
  reserveRandom(threadId: string): Promise<StorySourceRecord>;
  recordYoutubeEditUrl(threadId: string, editUrl: string): Promise<void>;
}
