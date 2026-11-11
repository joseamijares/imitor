// Stand-in for @shopify/react-native-skia. Drawings are not rendered:
// <Canvas> keeps its box so layout holds, and is marked so the report can say so.
const React = require("react");
const { View } = require("react-native");
const base = require("./inert");

function Canvas({ style, children: _children, ...rest }) {
  return React.createElement(View, {
    style,
    testID: rest.testID,
    accessibilityLabel: rest.accessibilityLabel,
    dataSet: { imitorStub: "skia" },
  });
}

module.exports = new Proxy(
  { __esModule: true, Canvas },
  { get: (own, key) => (key in own ? own[key] : base[key]) }
);
