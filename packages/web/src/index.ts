import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './ds/tokens.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(createElement(App));
