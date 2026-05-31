// This import+export works to make sure the index.html files is copied to the dest folder
// and that the import isn't stripped out during the bundling process.
import index from './index.html';
export function getFilePaths() {
  return { index };
};

// Pull in the paths from the glob plugin invocation.
import { imagePaths } from '../src/index.js';

const animationTimerInterval = 3000;

function startAnimationTimer(callback) {
  let lastTick = performance.now();
  function tick(now) {
    if (now - lastTick >= animationTimerInterval) {
      lastTick = now;
      callback(now);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

window.addEventListener('load', async () => {
  console.log(imagePaths);
  startAnimationTimer((now) => {
    console.log(`Animation timer fired at ${Math.round(now)}ms`);
  });
});
