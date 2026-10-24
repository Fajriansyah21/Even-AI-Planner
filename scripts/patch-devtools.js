const fs = require('fs');
const path = require('path');

const cjsTarget = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'next-devtools', 'userspace', 'app', 'segment-explorer-node.js');
const esmTarget = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'esm', 'next-devtools', 'userspace', 'app', 'segment-explorer-node.js');

const cjsContent = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SegmentViewNode = function(param) { return param ? param.children : null; };
exports.SegmentViewStateNode = function() { return null; };
exports.SegmentBoundaryTriggerNode = function() { return null; };
exports.SegmentStateProvider = function(param) { return param ? param.children : null; };
exports.useSegmentState = function() { return { boundaryType: null, setBoundaryType: function() {} }; };
exports.SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE = 'NEXT_DEVTOOLS_SIMULATED_ERROR';
`;

const esmContent = `export const SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE = 'NEXT_DEVTOOLS_SIMULATED_ERROR';
export function SegmentViewNode(param) { return param ? param.children : null; }
export function SegmentViewStateNode() { return null; }
export function SegmentBoundaryTriggerNode() { return null; }
export function SegmentStateProvider(param) { return param ? param.children : null; }
export function useSegmentState() { return { boundaryType: null, setBoundaryType: () => {} }; }
`;

try {
  if (fs.existsSync(cjsTarget)) {
    fs.writeFileSync(cjsTarget, cjsContent, 'utf-8');
    console.log('Successfully patched CJS segment-explorer-node.js');
  }
  if (fs.existsSync(esmTarget)) {
    fs.writeFileSync(esmTarget, esmContent, 'utf-8');
    console.log('Successfully patched ESM segment-explorer-node.js');
  }
} catch (err) {
  console.error('Error patching segment-explorer-node:', err);
}
