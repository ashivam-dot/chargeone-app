import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import { render } from 'preact';
import { App } from './App.tsx';
import './styles.css';
import './theme.css';

render(<App />, document.getElementById('app')!);
