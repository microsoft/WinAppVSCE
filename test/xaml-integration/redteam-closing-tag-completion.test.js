"use strict";

// WinUI XAML closing-tag completion. The server detail distinguishes close tags from VS Code word suggestions.

const assert = require("node:assert");
const h = require("./helper");

function page(inner) {
  return `<Page ${h.NS}\n    x:Class="SmokeFixture.SmokePage">\n  ${inner}\n</Page>`;
}

function dump(value) {
  return JSON.stringify(value);
}

function closeTag(items) {
  return items.filter((i) => i.detail === "Closing tag");
}

async function closingItems(buffer) {
  return closeTag(await h.completionItemsAt(buffer));
}

async function expectClosing(label, buffer, expectedLabel, expectedNewText) {
  const items = await closingItems(buffer);
  if (items.length !== 1) {
    assert.fail(`${label}: expected exactly one Closing tag item for buffer ${dump(buffer)}; got ${dump(items)}`);
  }
  if (items[0].label !== expectedLabel) {
    assert.fail(`${label}: expected label ${dump(expectedLabel)} for buffer ${dump(buffer)}; got ${dump(items)}`);
  }
  if (items[0].newText !== expectedNewText) {
    assert.fail(`${label}: expected newText ${dump(expectedNewText)} for buffer ${dump(buffer)}; got ${dump(items)}`);
  }
}

async function expectNoClosing(label, buffer) {
  const items = await closingItems(buffer);
  if (items.length !== 0) {
    assert.fail(`${label}: expected no Closing tag item for buffer ${dump(buffer)}; got ${dump(items)}`);
  }
}

describe("red-team 47 — closing-tag completion", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  const positiveCases = [
    {
      label: "bare close slash appends a greater-than",
      buffer: page("<Grid>\n    </|"),
      expectedLabel: "Grid",
      expectedNewText: "Grid>",
    },
    {
      label: "partial name appends a greater-than",
      buffer: page("<Grid>\n    </Gr|"),
      expectedLabel: "Grid",
      expectedNewText: "Grid>",
    },
    {
      label: "complete name at token end still appends a greater-than",
      buffer: page("<Grid>\n    </Grid|"),
      expectedLabel: "Grid",
      expectedNewText: "Grid>",
    },
    {
      label: "complete name reuses an existing greater-than",
      buffer: page("<Grid>\n    </Grid|>"),
      expectedLabel: "Grid",
      expectedNewText: "Grid",
    },
    {
      label: "empty VS Code auto-closed pair reuses an existing greater-than",
      buffer: page("<Grid>\n    </|>"),
      expectedLabel: "Grid",
      expectedNewText: "Grid",
    },
    {
      label: "partial name reuses an existing greater-than",
      buffer: page("<Grid>\n    </Gr|>"),
      expectedLabel: "Grid",
      expectedNewText: "Grid",
    },
    {
      label: "deep nesting chooses the innermost unclosed element",
      buffer: page("<Grid>\n    <StackPanel>\n      <Border>\n        </|"),
      expectedLabel: "Border",
      expectedNewText: "Border>",
    },
    {
      label: "after closing the deepest element the next unclosed ancestor wins",
      buffer: page("<Grid>\n    <StackPanel>\n      <Border></Border>\n      </|"),
      expectedLabel: "StackPanel",
      expectedNewText: "StackPanel>",
    },
    {
      label: "self-closed sibling before the caret is ignored",
      buffer: page("<Grid>\n    <Button />\n    <TextBlock />\n    </|"),
      expectedLabel: "Grid",
      expectedNewText: "Grid>",
    },
    {
      label: "mixed closed child and open parent chooses the innermost open element",
      buffer: page("<Grid>\n    <StackPanel>\n      <Button></Button>\n      </|"),
      expectedLabel: "StackPanel",
      expectedNewText: "StackPanel>",
    },
    {
      label: "dotted property element is offered as one whole name",
      buffer: page("<Grid>\n    <Grid.RowDefinitions>\n      <RowDefinition />\n      </|\n  </Grid>"),
      expectedLabel: "Grid.RowDefinitions",
      expectedNewText: "Grid.RowDefinitions>",
    },
    {
      label: "prefixed element is offered as one whole name",
      buffer: page("<Grid>\n    <local:MyControl>\n      </|"),
      expectedLabel: "local:MyControl",
      expectedNewText: "local:MyControl>",
    },
    {
      label: "mismatched partial end tag still balances the nearest open element",
      buffer: page("<Grid>\n    </Button|"),
      expectedLabel: "Grid",
      expectedNewText: "Grid>",
    },
    {
      label: "earlier bogus end tag does not prevent a later innermost open element from winning",
      buffer: page("<Grid>\n    </Bogus>\n    <StackPanel>\n      </|"),
      expectedLabel: "StackPanel",
      expectedNewText: "StackPanel>",
    },
  ];

  for (const c of positiveCases) {
    it(c.label, async () => {
      await expectClosing(c.label, c.buffer, c.expectedLabel, c.expectedNewText);
    });
  }

  const negativeCases = [
    {
      label: "caret between less-than and slash is not a close-tag context",
      buffer: page("<Grid>\n    <|/Grid>"),
    },
    {
      label: "caret after a trailing space past the name is suppressed",
      buffer: page("<Grid>\n    </Grid |"),
    },
    {
      label: "caret after a completed end tag is suppressed",
      buffer: page("<Grid>\n    </Grid>|"),
    },
    {
      label: "every enclosing element already closed gives no item",
      buffer: page("<Grid>\n    <Button />\n  </Grid>\n  </|"),
    },
    {
      label: "stray close slash at beginning of file gives no item",
      buffer: "</|",
    },
    {
      label: "close slash after a self-closed root gives no item",
      buffer: "<Grid />\n</|",
    },
    {
      label: "later real end tag already closes the only open element",
      buffer: page("<Grid>\n    </|\n  </Grid>"),
    },
    {
      label: "close slash as the only document content gives no item",
      buffer: "</|",
    },
    {
      label: "close slash inside XML comment is suppressed",
      buffer: page("<Grid>\n    <!-- </|Grid -->\n  </Grid>"),
    },
    {
      label: "close slash inside CDATA is suppressed",
      buffer: page("<Grid>\n    <![CDATA[ </|Grid ]]>\n  </Grid>"),
    },
    {
      label: "space immediately after close slash is suppressed",
      buffer: page("<Grid>\n    </ |"),
    },
    {
      label: "tab immediately after close slash is suppressed",
      buffer: page("<Grid>\n    </\t|"),
    },
    {
      label: "newline immediately after close slash is suppressed",
      buffer: page("<Grid>\n    </\n    |"),
    },
  ];

  for (const c of negativeCases) {
    it(c.label, async () => {
      await expectNoClosing(c.label, c.buffer);
    });
  }

  it("returns deterministic close-tag items for identical repeated requests", async () => {
    const buffer = page("<Grid>\n    <StackPanel>\n      </|>");
    const first = await closingItems(buffer);
    const second = await closingItems(buffer);
    assert.deepStrictEqual(second, first, `determinism: first=${dump(first)} second=${dump(second)} buffer=${dump(buffer)}`);
  });
});
