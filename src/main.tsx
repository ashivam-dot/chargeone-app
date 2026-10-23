import '@fontsource-variable/geist';
import '@fontsource-variable/noto-sans-devanagari';
import { render } from 'preact';
import { App } from './App.tsx';
import { warmCachesOnFirstControl } from './lib/swWarm.ts';
import './styles.css';
import './theme.css';
import './design.css';

warmCachesOnFirstControl();
render(<App />, document.getElementById('app')!);
