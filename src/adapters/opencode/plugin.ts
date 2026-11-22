import { Plugin } from '@opencode/plugin';
import { setup } from './setup.js';

/** OpenCode entry point; the handoff implementation lives in `setup.ts`. */
export default Plugin.define({ id: 'ai4ai', setup });
