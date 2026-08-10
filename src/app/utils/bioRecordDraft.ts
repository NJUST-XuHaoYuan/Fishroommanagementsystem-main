import type { BioRecord } from "../store";

export type BioRecordDraft = {
  date: string;
  text: string;
  photos: string[];
  videos: string[];
};

export function hasBioRecordDraftContent(draft: BioRecordDraft): boolean {
  return Boolean(
    draft.text.trim()
    || draft.photos.length > 0
    || draft.videos.length > 0
  );
}

export function bioRecordFromDraft(
  draft: BioRecordDraft,
  options: { id: string; stockItemId: string; date: string },
): BioRecord {
  return {
    id: options.id,
    stockItemId: options.stockItemId,
    date: options.date,
    text: draft.text,
    photos: [...draft.photos],
    videos: [...draft.videos],
  };
}
