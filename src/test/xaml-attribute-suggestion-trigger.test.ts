import assert from "node:assert/strict";
import test from "node:test";
import {
  isEnterEdit,
  shouldTriggerAttributeSuggestions,
  shouldTriggerElementSuggestions,
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

test("triggers when less-than starts an element on a new content line", () => {
  const [text, offset] = caret("<Page>\n  <|\n</Page>");
  assert.equal(shouldTriggerElementSuggestions(text, offset), true);
});

test("does not trigger element suggestions inside attributes, comments, or CDATA", () => {
  const [attribute, attributeOffset] = caret('<Button Content="<|" />');
  const [comment, commentOffset] = caret("<Page><!-- <| --></Page>");
  const [cdata, cdataOffset] = caret("<Page><![CDATA[ <| ]]></Page>");

  assert.equal(shouldTriggerElementSuggestions(attribute, attributeOffset), false);
  assert.equal(shouldTriggerElementSuggestions(comment, commentOffset), false);
  assert.equal(shouldTriggerElementSuggestions(cdata, cdataOffset), false);
});
