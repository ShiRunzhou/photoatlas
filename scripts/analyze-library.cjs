'use strict';
// Run the same desktop analysis against the real library without confirming
// imports or deleting files. Electron holds the usual single-instance lock.
process.env.PHOTOATLAS_TEST_MODE = '1';
const fs = require('fs'),
  path = require('path');
const { app } = require('electron');
const desktop = require('../desktop/main.cjs');
desktop.ready
  .then(async () => {
    await desktop.syncLibrary();
    await desktop.startAnalysis();
    let last = '';
    const timer = setInterval(() => {
      const state = desktop.getState(),
        progress = state.progress;
      if (progress) {
        const bucket = Math.floor(
            (progress.done / Math.max(1, progress.total)) * 20,
          ),
          key = progress.phase + bucket;
        if (key !== last) {
          console.log(JSON.stringify(progress));
          last = key;
        }
      }
      if (state.analysis?.status === 'complete') {
        clearInterval(timer);
        const report = {
          at: new Date().toISOString(),
          photos: state.photos.length,
          groups: state.groups.length,
          groupPhotos: new Set(state.groups.flatMap((g) => g.photoIds)).size,
          groupSizes: state.groups.map((g) => g.count),
          analysis: { ...state.analysis, edges: state.analysis.edges.length },
          errors: state.photos
            .filter((p) => p.readError || p.missing)
            .map((p) => ({
              id: p.id,
              fileName: p.fileName,
              readError: p.readError,
              missing: p.missing,
            })),
        };
        fs.writeFileSync(
          path.join(__dirname, '../data/initial-comparison-report.json'),
          JSON.stringify(report, null, 2),
        );
        console.log(JSON.stringify(report));
        app.quit();
      } else if (state.analysis?.status === 'interrupted') {
        clearInterval(timer);
        console.error(state.analysis.error || '分析中断');
        app.exit(1);
      }
    }, 1000);
  })
  .catch((error) => {
    console.error(error.stack);
    app.exit(1);
  });
