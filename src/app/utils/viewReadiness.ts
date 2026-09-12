export type LoadedViewState = { view: string; userKey: string };

/** A previous page's loaded data cannot authorize mounting the next page. */
export function isViewStateReady(
  loaded: LoadedViewState | null,
  view: string,
  userKey: string,
): boolean {
  return Boolean(userKey && loaded?.view === view && loaded.userKey === userKey);
}
