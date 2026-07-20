const assert = require("node:assert/strict");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const { resolve } = require("node:path");

const moduleUrl = pathToFileURL(
  resolve(__dirname, "../page-insertion.mjs")
).href;

const page = (id, groupId = null, groupName = undefined) => ({
  id,
  groupId,
  ...(groupName ? { groupName } : {}),
});

test("a single inserted page joins the group at the current position", async () => {
  const { arrangeInsertedPages, PAGE_INSERTION_MODE } = await import(moduleUrl);
  const pages = [
    page("a", "original", "原始群組"),
    page("b", "original", "原始群組"),
    page("tail"),
    page("new", "source-new"),
  ];
  const arranged = arrangeInsertedPages({
    pages,
    insertedIds: ["new"],
    anchorPageId: "a",
    mode: PAGE_INSERTION_MODE.CURRENT_GROUP,
    targetGroupName: "原始群組",
  });

  assert.deepEqual(arranged.map(({ id }) => id), ["a", "new", "b", "tail"]);
  assert.equal(arranged[1].groupId, "original");
  assert.equal(arranged[1].groupName, "原始群組");
});

test("multiple inserted pages can join the current group", async () => {
  const { arrangeInsertedPages, PAGE_INSERTION_MODE } = await import(moduleUrl);
  const pages = [
    page("a", "original"),
    page("b", "original"),
    page("new-1", "source-new"),
    page("new-2", "source-new"),
  ];
  const arranged = arrangeInsertedPages({
    pages,
    insertedIds: ["new-1", "new-2"],
    anchorPageId: "a",
    mode: PAGE_INSERTION_MODE.CURRENT_GROUP,
    targetGroupName: "原始檔案.pdf",
  });

  assert.deepEqual(arranged.map(({ id }) => id), ["a", "new-1", "new-2", "b"]);
  assert.deepEqual(
    arranged.slice(0, 4).map(({ groupId }) => groupId),
    ["original", "original", "original", "original"]
  );
});

test("multiple inserted pages can form a new group after the current group", async () => {
  const { arrangeInsertedPages, PAGE_INSERTION_MODE } = await import(moduleUrl);
  const pages = [
    page("a", "original"),
    page("b", "original"),
    page("tail"),
    page("new-1", "source-new"),
    page("new-2", "source-new"),
  ];
  const arranged = arrangeInsertedPages({
    pages,
    insertedIds: ["new-1", "new-2"],
    anchorPageId: "a",
    mode: PAGE_INSERTION_MODE.AFTER_GROUP,
    newGroupId: "inserted-group",
  });

  assert.deepEqual(arranged.map(({ id }) => id), [
    "a",
    "b",
    "new-1",
    "new-2",
    "tail",
  ]);
  assert.deepEqual(
    arranged.slice(2, 4).map(({ groupId }) => groupId),
    ["inserted-group", "inserted-group"]
  );
});

test("an anchor outside a group keeps ordinary after-page insertion", async () => {
  const { arrangeInsertedPages, PAGE_INSERTION_MODE } = await import(moduleUrl);
  const pages = [page("a"), page("b"), page("new-1", "source-new")];
  const arranged = arrangeInsertedPages({
    pages,
    insertedIds: ["new-1"],
    anchorPageId: "a",
    mode: PAGE_INSERTION_MODE.AFTER_ANCHOR,
  });

  assert.deepEqual(arranged.map(({ id }) => id), ["a", "new-1", "b"]);
  assert.equal(arranged[1].groupId, "source-new");
});
