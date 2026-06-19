import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';

const target = document.querySelector<HTMLElement>('#app');

if (!target) {
  throw new Error('WorldForge could not find #app.');
}

mount(App, { target });
