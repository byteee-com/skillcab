import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

test("installs to a project, opens its directory, uninstalls and restores it", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(".local/e2e-state.json", "utf8"),
  ) as { installSource: string; openLog: string; project: string };
  await page.goto("/");
  await page.getByRole("button", { name: "安装 Skill", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("安装范围").selectOption({ label: "sample-project" });
  await dialog.getByLabel("来源", { exact: true }).fill(fixture.installSource);
  await dialog.getByRole("button", { name: "读取来源", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: /选择 Skill/ }),
  ).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "Claude Code", exact: true })
    .check();
  await dialog.getByRole("button", { name: "预览安装", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "确认安装", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("写入安装来源记录", { exact: true }),
  ).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await expect(
    dialog.getByRole("button", { name: "确认安装", exact: true }),
  ).toBeInViewport();
  await expect(
    dialog.getByRole("heading", { name: "确认安装", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: ".local/install-preview.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "确认安装", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /installed-reader/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /installed-reader/ }).click();
  await page.getByRole("button", { name: "打开目录", exact: true }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(
          await readFile(fixture.openLog, "utf8").catch(() => '{"path":""}'),
        ).path,
    )
    .toBe(`${fixture.project}/.agents/skills/installed-reader`);
  await page.getByRole("button", { name: "卸载", exact: true }).click();
  await dialog.getByRole("button", { name: "预览卸载", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "确认卸载", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "确认卸载", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /installed-reader/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "撤销卸载", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /installed-reader/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /installed-reader/ }).click();
  await page.getByRole("button", { name: "卸载", exact: true }).click();
  await dialog.getByRole("button", { name: "预览卸载", exact: true }).click();
  await dialog.getByRole("button", { name: "确认卸载", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /installed-reader/ }),
  ).toHaveCount(0);
});

test("desktop inventory, safe documents, source details, search and project registration", async ({
  page,
}) => {
  const errors: string[] = [];
  const remoteRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith("http://127.0.0.1:4318"))
      remoteRequests.push(request.url());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /repository-map/ }),
  ).toBeVisible();
  await expect(page.locator(".skill-list > li")).toHaveCount(3);
  await page.getByRole("button", { name: /repository-map/ }).click();
  await expect(page.locator(".markdown h1")).toHaveText("Repository map");
  expect(
    await page.evaluate(
      () => (window as Window & { __skillExecuted?: boolean }).__skillExecuted,
    ),
  ).toBeUndefined();
  expect(remoteRequests).toEqual([]);
  await page.getByRole("tab", { name: "文档", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "安装与来源" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator(".detail-scroll").getByText("example/skills", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator(".metadata-list").getByText("未检查", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /^文件/ }).click();
  await expect(page.locator(".file-list").getByText("SKILL.md")).toBeVisible();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page
    .getByRole("combobox", { name: "按来源筛选" })
    .selectOption("skills-cli");
  await expect(page.locator(".skill-list > li")).toHaveCount(1);
  await page.getByRole("combobox", { name: "按来源筛选" }).selectOption("all");
  await page.keyboard.press("/");
  await expect(
    page.getByRole("textbox", { name: "搜索 Skills" }),
  ).toBeFocused();
  await page.getByRole("textbox", { name: "搜索 Skills" }).fill("not-a-match");
  await expect(
    page.getByRole("heading", { name: "没有匹配的 Skills" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "清除筛选" }).click();
  await page
    .getByRole("button", { name: "添加项目", exact: true })
    .last()
    .click();
  await page
    .getByRole("textbox", { name: "项目目录" })
    .fill("/does-not-exist-skills-console");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加项目", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("目录不存在，请检查路径。");
  const fixture = JSON.parse(
    await readFile(".local/e2e-state.json", "utf8"),
  ) as { secondProject: string };
  await page
    .getByRole("textbox", { name: "项目目录" })
    .fill(fixture.secondProject);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "添加项目", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: "another-project" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /second-reader/ }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /包含全局可见候选/ }).check();
  await expect(page.locator(".skill-list > li")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("mobile navigation, project-only list and detail close", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: /repository-map/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开导航" }).click();
  await page
    .getByRole("button", { name: "sample-project", exact: true })
    .click();
  await expect(page.locator(".skill-list > li")).toHaveCount(1);
  await page.getByRole("button", { name: /project-reader/ }).click();
  await expect(page.locator(".markdown h1")).toHaveText("Project reader");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(
    page.getByRole("button", { name: /project-reader/ }),
  ).toBeVisible();
});

test("records manual sources, checks versions, shows logos and persists results without a token", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(".local/e2e-state.json", "utf8"),
  ) as { home: string; manualSource: string };
  await page.goto("/");
  await page.getByRole("button", { name: /local-notes/ }).click();
  await page.getByRole("tab", { name: "安装与来源" }).click();
  await page.getByRole("button", { name: "补录来源", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("来源地址").fill(fixture.manualSource);
  await dialog.getByRole("button", { name: "核验并保存", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "检查此 Skill", exact: true }).click();
  await expect(
    page.locator(".metadata-list").getByText("已是最新", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".detail-scroll")
      .getByText("关联时内容核验一致", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭详情" }).click();
  const card = page.getByRole("button", { name: /local-notes/ });
  await expect(card.locator(".update-current")).toHaveText("已是最新");
  await expect(
    card.getByRole("img", { name: "Codex", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(card.locator(".update-current")).toHaveText("已是最新");
  const sourceDoc = `${fixture.manualSource}/SKILL.md`;
  await writeFile(
    sourceDoc,
    (await readFile(sourceDoc, "utf8")).replace("1.0.0", "2.0.0"),
  );
  await card.click();
  await page.getByRole("tab", { name: "安装与来源" }).click();
  await page.getByRole("button", { name: "检查此 Skill", exact: true }).click();
  await expect(
    page.locator(".metadata-list").getByText("有更新", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(card.locator(".update-available")).toHaveText("有更新");
  await page.getByRole("button", { name: "只看有更新", exact: true }).click();
  await expect(page.locator(".skill-list > li")).toHaveCount(1);
  await page.getByRole("button", { name: "只看有更新", exact: true }).click();
  await page.screenshot({
    path: ".local/version-list-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /local-notes/ }).click();
  await page.getByRole("tab", { name: "安装与来源" }).click();
  await page.getByRole("button", { name: "编辑来源", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "编辑来源" }),
  ).toBeInViewport();
  await page.screenshot({ path: ".local/source-dialog-mobile.png" });
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
    true,
  );
  await dialog.getByRole("button", { name: "移除关联", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("registers dragged paths together and uses the system picker when paths are hidden", async ({
  page,
}) => {
  const fixture = JSON.parse(
    await readFile(".local/e2e-state.json", "utf8"),
  ) as { dropProjects: string[] };
  await page.goto("/");
  const list = page.getByRole("navigation", { name: "项目列表" });
  await expect(
    list.getByRole("button", { name: "sample-project" }),
  ).toBeVisible();
  const target = page.locator(".add-project-button");
  const paths = fixture.dropProjects.map((path) => pathToFileURL(path).href);
  const transfer = await page.evaluateHandle((urls) => {
    const data = new DataTransfer();
    data.setData("text/uri-list", urls.join("\r\n"));
    return data;
  }, paths);
  await target.dispatchEvent("dragover", { dataTransfer: transfer });
  await expect(target).toHaveClass(/is-dropping/);
  await target.dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page.getByRole("heading", { level: 1, name: "dragged one" }),
  ).toBeVisible();
  await expect(list.getByRole("button", { name: "dragged-two" })).toBeVisible();
  await expect(target).not.toHaveClass(/is-dropping/);

  const hiddenPath = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File([], "picked-project"));
    return data;
  });
  await target.dispatchEvent("drop", { dataTransfer: hiddenPath });
  await expect(
    page.getByRole("heading", { level: 1, name: "picked-project" }),
  ).toBeVisible();

  await page.reload();
  await expect(list.getByRole("button", { name: "dragged one" })).toBeVisible();
  await expect(list.getByRole("button", { name: "dragged-two" })).toBeVisible();
  await expect(
    list.getByRole("button", { name: "picked-project" }),
  ).toBeVisible();
});
