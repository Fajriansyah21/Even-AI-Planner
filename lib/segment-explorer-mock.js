"use strict";
Object.defineProperty(exports, "__esModule", { value: true });

function SegmentViewNode(param) {
  return param ? param.children : null;
}
SegmentViewNode.displayName = 'SegmentViewNode';

function SegmentViewStateNode() {
  return null;
}
SegmentViewStateNode.displayName = 'SegmentViewStateNode';

function SegmentBoundaryTriggerNode() {
  return null;
}
SegmentBoundaryTriggerNode.displayName = 'SegmentBoundaryTriggerNode';

function SegmentStateProvider(param) {
  return param ? param.children : null;
}
SegmentStateProvider.displayName = 'SegmentStateProvider';

function useSegmentState() {
  return { boundaryType: null, setBoundaryType: function() {} };
}

exports.SegmentViewNode = SegmentViewNode;
exports.SegmentViewStateNode = SegmentViewStateNode;
exports.SegmentBoundaryTriggerNode = SegmentBoundaryTriggerNode;
exports.SegmentStateProvider = SegmentStateProvider;
exports.useSegmentState = useSegmentState;
exports.SEGMENT_EXPLORER_SIMULATED_ERROR_MESSAGE = 'NEXT_DEVTOOLS_SIMULATED_ERROR';
