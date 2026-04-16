// This import+export works to make sure the index.html files is copied to the dest folder
// and that the import isn't stripped out during the bundling process.
import index from './index.html';
export function getFilePaths() {
  return { index };
};

// Pull in the paths from the glob plugin invocation.
import { imagePaths } from '../src/index.js';

window.addEventListener('load', async () => {
  console.log(imagePaths);
});
