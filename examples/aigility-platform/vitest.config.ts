import { defineConfig } from "vitest/config";

// 包根测试配置：合并服务端（src/）与前端（app/src/）两个测试区。
// 此前 test 脚本跑在 app/ 下（vite 项目根），src/ 的测试（如 site-improver）从未被执行——
// 本配置修复该盲区；app 下未来出现组件测试时再挂 react 插件。
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "app/src/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    // 工作区包（@aigility-harness/*）经 pnpm 链接解析到各自 src/*.ts，无需别名
  },
});
