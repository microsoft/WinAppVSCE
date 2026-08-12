import assert from "node:assert/strict";
import test from "node:test";
import {
  isEnterEdit,
  shouldTriggerAttributeSuggestions,
} from "../xaml/attributeSuggestionTrigger";

function caret(marked: string): [string, number] {
  const offset = marked.indexOf("|");
  assert.notEqual(offset, -1);
  return [marked.slice(0, offset) + marked.slice(offset + 1), offset];
}

test("triggers on a new attribute line after existing attributes", () => {
  const [text, offset] = caret(`<Button
 x:Name="CounterButton"
 AutomationProperties.AutomationId="CounterButton"
 AutomationProperties.Name="Counter Button"
 Click="CounterButton_Click"
 Content="Click Me"
 | />`);

  assert.equal(shouldTriggerAttributeSuggestions(text, offset), true);
});

test("triggers with automatic indentation inserted by Enter", () => {
  const [text, offset] = caret("<Button\n    | />");
  assert.equal(shouldTriggerAttributeSuggestions(text, offset), true);
});

test("does not trigger in element content or an attribute value", () => {
  const [content, contentOffset] = caret("<Button>\n  |text\n</Button>");
  const [value, valueOffset] = caret('<Button Content="first\n  |second" />');

  assert.equal(shouldTriggerAttributeSuggestions(content, contentOffset), false);
  assert.equal(shouldTriggerAttributeSuggestions(value, valueOffset), false);
});

test("recognizes only an Enter edit with optional indentation", () => {
  assert.equal(isEnterEdit("\n"), true);
  assert.equal(isEnterEdit("\r\n    "), true);
  assert.equal(isEnterEdit("a"), false);
  assert.equal(isEnterEdit("\n  a"), false);
});
