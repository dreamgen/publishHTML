export async function copyPagesBySource(outputDocument, entries) {
  const groups = new Map();
  const seenKeys = new Set();

  for (const entry of entries) {
    if (!entry?.key) throw new Error("Copied page entry requires a key.");
    if (seenKeys.has(entry.key)) {
      throw new Error(`Duplicate copied page key: ${entry.key}`);
    }
    if (!entry.sourceDocument) {
      throw new Error(`Missing source document for copied page: ${entry.key}`);
    }
    if (!Number.isInteger(entry.sourcePageIndex) || entry.sourcePageIndex < 0) {
      throw new Error(`Invalid source page index for copied page: ${entry.key}`);
    }
    seenKeys.add(entry.key);
    let group = groups.get(entry.sourceDocument);
    if (!group) {
      group = [];
      groups.set(entry.sourceDocument, group);
    }
    group.push(entry);
  }

  const copiedByKey = new Map();
  for (const [sourceDocument, group] of groups) {
    // A single copyPages call shares one foreign-object copier. Calling it once
    // per page duplicates common fonts and images in the destination PDF.
    const copiedPages = await outputDocument.copyPages(
      sourceDocument,
      group.map((entry) => entry.sourcePageIndex)
    );
    copiedPages.forEach((page, index) => {
      copiedByKey.set(group[index].key, page);
    });
  }
  return copiedByKey;
}
