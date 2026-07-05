const fs = require('fs');
const path = require('path');

const directoryPath = __dirname;
const outputFile = path.join(directoryPath, 'data.json');

const files = fs.readdirSync(directoryPath);
const htmlFiles = files.filter(file => file.endsWith('.html') && file !== 'index.html');

const fileData = [];

htmlFiles.forEach(file => {
  const filePath = path.join(directoryPath, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const stats = fs.statSync(filePath);

  // Extract Title
  let title = file;
  const titleMatch = content.match(/<title>(.*?)<\/title>/is);
  if (titleMatch && titleMatch[1]) {
    title = titleMatch[1].trim();
  }

  // Extract Type from meta
  let type = '未分類';
  const typeMatch = content.match(/<meta\s+name=["']type["']\s+content=["'](.*?)["']\s*\/?>/is);
  if (typeMatch && typeMatch[1]) {
    type = typeMatch[1].trim();
  }

  // Extract Date from meta or use file stat
  let dateStr = stats.birthtime.toISOString();
  const dateMatch = content.match(/<meta\s+name=["']date["']\s+content=["'](.*?)["']\s*\/?>/is);
  if (dateMatch && dateMatch[1]) {
    dateStr = dateMatch[1].trim();
  }

  fileData.push({
    filename: file,
    title: title,
    type: type,
    date: dateStr,
    size: stats.size
  });
});

// Sort by date descending initially
fileData.sort((a, b) => new Date(b.date) - new Date(a.date));

fs.writeFileSync(outputFile, JSON.stringify(fileData, null, 2));
console.log(`Successfully generated data.json with ${fileData.length} items.`);
