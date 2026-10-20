import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/noto-sans-devanagari';
import { render } from 'preact';
import { App } from './App.tsx';
import { installGlass } from './ui/glass.ts';
import './styles.css';
import './theme.css';
import './design.css';

render(<App />, document.getElementById('app')!);
installGlass();
