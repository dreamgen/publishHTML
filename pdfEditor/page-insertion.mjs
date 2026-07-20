export const PAGE_INSERTION_MODE = Object.freeze({
  AFTER_ANCHOR: "after-anchor",
  CURRENT_GROUP: "current-group",
  AFTER_GROUP: "after-group",
});

export function getContainingPageGroup(pages, anchorPageId) {
  const anchorIndex = pages.findIndex((page) => page.id === anchorPageId);
  if (anchorIndex < 0) return null;
  const groupId = pages[anchorIndex].groupId;
  if (!groupId) return null;

  const memberIndices = [];
  for (let index = 0; index < pages.length; index += 1) {
    if (pages[index].groupId === groupId) memberIndices.push(index);
  }
  if (memberIndices.length < 2) return null;

  return {
    groupId,
    anchorIndex,
    firstIndex: memberIndices[0],
    lastIndex: memberIndices[memberIndices.length - 1],
    pageCount: memberIndices.length,
  };
}

export function arrangeInsertedPages({
  pages,
  insertedIds,
  anchorPageId,
  mode = PAGE_INSERTION_MODE.AFTER_ANCHOR,
  newGroupId = null,
  targetGroupName = "",
}) {
  const insertedSet = new Set(insertedIds);
  const inserted = pages.filter((page) => insertedSet.has(page.id));
  if (!inserted.length) return pages;

  const context = getContainingPageGroup(pages, anchorPageId);
  const remaining = pages.filter((page) => !insertedSet.has(page.id));
  const anchorIndex = remaining.findIndex((page) => page.id === anchorPageId);
  if (anchorIndex < 0) return pages;

  let insertionIndex = anchorIndex + 1;
  if (mode === PAGE_INSERTION_MODE.CURRENT_GROUP && context) {
    for (const page of inserted) {
      page.groupId = context.groupId;
      if (targetGroupName) page.groupName = targetGroupName;
      else delete page.groupName;
    }
  } else if (mode === PAGE_INSERTION_MODE.AFTER_GROUP && context) {
    if (!newGroupId) {
      throw new Error("A new group id is required for after-group insertion.");
    }
    for (const page of inserted) {
      page.groupId = newGroupId;
      delete page.groupName;
    }
    const groupIndices = remaining
      .map((page, index) => (page.groupId === context.groupId ? index : -1))
      .filter((index) => index >= 0);
    insertionIndex = Math.max(...groupIndices) + 1;
  }

  return [
    ...remaining.slice(0, insertionIndex),
    ...inserted,
    ...remaining.slice(insertionIndex),
  ];
}
