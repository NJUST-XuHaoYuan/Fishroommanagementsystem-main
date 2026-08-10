import test from "node:test";
import assert from "node:assert/strict";
import {
  bioRecordFromDraft,
  hasBioRecordDraftContent,
} from "./bioRecordDraft.ts";

test("treats a video-only upload as a pending bio record", () => {
  assert.equal(hasBioRecordDraftContent({
    date: "2026-08-10T15:30:00",
    text: "",
    photos: [],
    videos: ["/uploads/fish-video.mp4"],
  }), true);
});

test("keeps uploaded videos when creating the record saved with bio details", () => {
  const record = bioRecordFromDraft({
    date: "2026-08-10T15:30:00",
    text: "观察记录",
    photos: ["/uploads/fish-photo.jpg"],
    videos: ["/uploads/fish-video.mp4"],
  }, {
    id: "record-1",
    stockItemId: "stock-1",
    date: "2026-08-10T15:30:00",
  });

  assert.deepEqual(record, {
    id: "record-1",
    stockItemId: "stock-1",
    date: "2026-08-10T15:30:00",
    text: "观察记录",
    photos: ["/uploads/fish-photo.jpg"],
    videos: ["/uploads/fish-video.mp4"],
  });
});

test("ignores an empty record draft", () => {
  assert.equal(hasBioRecordDraftContent({
    date: "2026-08-10T15:30:00",
    text: "  ",
    photos: [],
    videos: [],
  }), false);
});
