import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

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
  await page.goto("/#token=browser-test-session");
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
  await expect(page.getByText("example/skills", { exact: true })).toBeVisible();
  await expect(page.getByText("未检查", { exact: true })).toBeVisible();
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
  await page.goto("/#token=browser-test-session");
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
