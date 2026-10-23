import '@fontsource-variable/geist';
import '@fontsource-variable/noto-sans-devanagari';
import { render } from 'preact';
import { App } from './App.tsx';
import { warmCachesOnFirstControl } from './lib/swWarm.ts';
import './styles.css';
import './theme.css';
import './design.css';

warmCachesOnFirstControl();
// Not needed for the first paint, so it loads after start-up.
void import('./lib/swUpdate.ts').then((m) => m.watchForUpdatesInBrowser());
render(<App />, document.getElementById('app')!);
