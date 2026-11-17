// The daily shared pull for the public site: every outside source, built with default scoring and
// no league, saved as latest.json and raw.json in PIVOT_DATA_DIR. Run by .github/workflows/pages.yml;
// the history and predictions folders are carried between runs so day-over-day movement and the
// live track record keep going. Exits non-zero if the pull failed.
import { refreshShared, shared } from '../lib/hosted.mjs';

await refreshShared();
if (shared.job.error || !shared.data) { console.error(shared.job.error || 'No data'); process.exit(1); }
