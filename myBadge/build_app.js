const fs = require('fs');

try {
  const iconBase64 = fs.readFileSync('icon.png').toString('base64');
  const iconDataUri = 'data:image/png;base64,' + iconBase64;

  let html = fs.readFileSync('index.html', 'utf8'); // Read from index.html

  // Replace iconUrl
  html = html.replace(
    "const iconUrl = new URL('icon.png', window.location.href).href;",
    `const iconUrl = "${iconDataUri}";`
  );

  // Add apple-touch-icon
  if (!html.includes('apple-touch-icon')) {
    html = html.replace(
      '</head>',
      `  <link rel="apple-touch-icon" href="${iconDataUri}">\n</head>`
    );
  }

  // Read sw.js
  const swCode = fs.readFileSync('sw.js', 'utf8');
  const escapedSwCode = swCode.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  // Replace SW registration
  const swRegMatch = `navigator.serviceWorker.register('./sw.js', { scope: './' })`;
  const newSwReg = `
          const swCode = \`${escapedSwCode}\`;
          const swBlob = new Blob([swCode], { type: 'application/javascript' });
          const swUrl = URL.createObjectURL(swBlob);
          navigator.serviceWorker.register(swUrl, { scope: './' })
`;

  html = html.replace(swRegMatch, newSwReg.trim());

  fs.writeFileSync('app.html', html);
  console.log('Successfully built app.html from index.html');
} catch (e) {
  console.error('Error:', e);
}
