const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'main.js');
let content = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n'); // Normalize line endings for exact string matching

const target = `                  const formatTime = (ts) => ts ? \`<div style="font-weight:800; font-size:14px; color:#1e293b;">\${new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>\` : '<div style="color:#cbd5e1;">--:--</div>';
                  
                  const mapLink = (coords) => coords ? \`
                    <a href="https://www.google.com/maps?q=\${coords.lat},\${coords.lng}" target="_blank" style="color:#10b981; display:inline-flex; align-items:center; margin-left:8px;" title="GPS"><i data-lucide="map-pin" style="width:12px;"></i></a>
                  \` : '';

                  return \``;

const replacement = `                  const formatTime = (ts) => ts ? \`<div style="font-weight:800; font-size:14px; color:#1e293b;">\${new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div>\` : '<div style="color:#cbd5e1; font-weight:500;">--:--</div>';
                  
                  const mapLink = (coords) => coords ? \`
                    <a href="https://www.google.com/maps?q=\${coords.lat},\${coords.lng}" target="_blank" style="color:#10b981; display:inline-flex; align-items:center; margin-left:8px;" title="GPS"><i data-lucide="map-pin" style="width:12px;"></i></a>
                  \` : '';

                  let arrivalDiffHtml = '';
                  let departureDiffHtml = '';

                  if (scheduled) {
                     const sStart = new Date(scheduled.start_time);
                     const sEnd = new Date(scheduled.end_time);

                     if (r.firstArrival) {
                        const arrT = new Date(r.firstArrival);
                        const diff = Math.floor((arrT.getTime() - sStart.getTime()) / 60000);
                        if (diff > 0) arrivalDiffHtml = \`<div style="color:#b45309; font-size:9px; font-weight:800; text-transform:uppercase;">⚠ \${diff} min tarde</div>\`;
                        else arrivalDiffHtml = \`<div style="color:#166534; font-size:9px; font-weight:800; text-transform:uppercase;">✓ \${Math.abs(diff)} min antes</div>\`;
                     }

                     if (r.lastDeparture) {
                        const depT = new Date(r.lastDeparture);
                        const diff = Math.floor((depT.getTime() - sEnd.getTime()) / 60000);
                        if (diff > 0) departureDiffHtml = \`<div style="color:#1d4ed8; font-size:9px; font-weight:800; text-transform:uppercase;">⚡ \${diff} min extra</div>\`;
                        else departureDiffHtml = \`<div style="color:#b91c1c; font-size:9px; font-weight:800; text-transform:uppercase;">❌ \${Math.abs(diff)} min menos</div>\`;
                     }
                  }

                  return \``;

const tableTarget = `                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        \${formatTime(r.firstArrival)}
                        \${mapLink(r.gpsArrival)}
                      </div>
                    </td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        \${formatTime(r.lastDeparture)}
                        \${mapLink(r.gpsDeparture)}
                      </div>
                    </td>`;

const tableReplacement = `                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        \${formatTime(r.firstArrival)}
                        \${mapLink(r.gpsArrival)}
                      </div>
                      \${arrivalDiffHtml}
                    </td>
                    <td style="padding:18px;">
                      <div style="display:flex; align-items:center;">
                        \${formatTime(r.lastDeparture)}
                        \${mapLink(r.gpsDeparture)}
                      </div>
                      \${departureDiffHtml}
                    </td>`;

let edits = 0;
if (content.includes(target)) {
    console.log('Logic target MATCHED');
    content = content.replace(target, replacement);
    edits++;
}

if (content.includes(tableTarget)) {
    console.log('Table target MATCHED');
    content = content.replace(tableTarget, tableReplacement);
    edits++;
}

if (edits === 2) {
    fs.writeFileSync(filePath, content, 'utf8'); // Normal node defaults save successfully
    console.log('PATCH 100% APPLIED SUCCESSFULLY!');
} else {
    console.error(`PATCH FAILED! Matches found: \${edits}/2`);
    process.exit(1);
}
