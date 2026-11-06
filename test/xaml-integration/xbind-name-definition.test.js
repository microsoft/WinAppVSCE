"use strict";

const assert = require("node:assert/strict");
const h = require("./helper");

describe("x:Bind element-name definitions", function () {
  this.timeout(180000);
  before(async () => { await h.warmUp(); });
  after(async () => { await h.revertProbe(); });

  for (const expression of ["Head|ing.Text", "Path=Head|ing.Text", "FindName(Head|ing.Text)"]) {
    it(`navigates ${expression} to the XAML declaration, not generated C#`, async () => {
      const buffer = `<Page ${h.NS} x:Class="SmokeFixture.SmokePage">
  <StackPanel>
    <TextBlock x:Name="Heading" />
    <TextBlock Text="{x:Bind ${expression}}" />
  </StackPanel>
</Page>`;
      const locations = await h.definitionsAt(buffer);
      assert.equal(locations.length, 1);
      assert.match(locations[0].fsPath, /SmokePage\.xaml$/i);
      assert.equal(locations[0].line, buffer.slice(0, buffer.indexOf('x:Name="Heading"')).split("\n").length - 1);
    });
  }
});
