// The owner's admin console (admin.html), built as its own entry so none of it ships with the app.
import '@fontsource-variable/geist';
import { render } from 'preact';
import { AdminApp } from './AdminApp.tsx';
import './admin.css';

render(<AdminApp />, document.getElementById('admin')!);
