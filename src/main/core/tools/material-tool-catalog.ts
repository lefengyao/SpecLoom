import { z } from "zod";
import { VersionTokenSchema } from "../../../shared/contracts";
import { materialImagePath } from "../../../shared/material-images";
import { StateMachineSchema } from "../../../shared/state-machine";
import type { WorkTool } from "./catalog";

const path = z.string().min(1).max(2048);
const text = z.string().max(65536);
const category = z.enum(["entity", "component", "map", "setting", "ui", "spec"]);
const value = z.union([z.number().finite(), z.string().max(65536), z.boolean()]);
const values = z.record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).refine(key => !["__proto__", "prototype", "constructor"].includes(key)), value);
const field = z.object({ key: z.string().min(1).max(100), label: z.string().max(200).optional(), type: z.enum(["number", "string", "boolean"]), default: value }).strict();
const changes = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: text.optional(),
  group: z.string().trim().max(100).nullable().optional(), groupId: z.string().trim().min(1).max(200).nullable().optional(), parent: path.nullable().optional(), extends: path.nullable().optional(),
  scope: z.enum(["system", "user"]).optional(),
  type: z.enum(["entity", "character", "enemy", "map", "system", "item", "event", "component", "setting", "ui", "spec"]).optional(),
  status: z.string().trim().min(1).max(100).optional(), version: z.union([z.number().int().positive(), z.string().min(1).max(100)]).optional(),
  source: z.string().min(1).max(200).optional(), relations: z.array(path).max(256).optional(),
  fields: z.array(field).max(256).optional(), components: z.array(z.object({ id: path, values: values.optional() }).strict()).max(256).optional(),
  stateMachine: StateMachineSchema.nullable().optional(),
}).strict();
const guarded = { path, expectedVersion: VersionTokenSchema.refine(version => version !== "absent", "先 MaterialRead 获取已有资料版本") };

export const materialToolDefinitions: WorkTool[] = [
  { name: "MaterialsList", description: "查询应用内实体、组件、地图、设定、UI、规范资料；可按类别、稳定分组 ID（包含后代）、实体类型和关键词组合筛选，并返回层级分组树、路径、摘要与版本。旧 group 文本筛选仍可用。", initial: true, schema: z.object({ category: category.optional(), query: z.string().max(2000).optional(), group: z.string().max(100).optional(), groupId: z.string().trim().min(1).max(200).optional(), entityType: z.enum(["entity", "character", "enemy", "item", "system", "event"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: "MaterialRead", description: "读取应用内资料的元数据、正文、完整内容和版本。后续修改必须携带返回的 expectedVersion。", initial: true, schema: z.object({ path }).strict() },
  { name: "MaterialCreate", description: "按名称创建并立即保存资料；category 支持 entity/component/map/setting/ui/spec，省略 id 自动生成。properties 可定义组件字段、scope（system/user）、稳定 groupId 及关系；不创建智能体任务。", schema: z.object({ category, title: z.string().trim().min(1).max(200), id: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(), body: text.optional(), properties: changes.omit({ title: true }).optional() }).strict() },
  { name: "MaterialUpdate", description: "保存资料名称、说明、scope、稳定 groupId、父级、继承、组件字段或正文；必须先读版本。groupId/parent/extends=null 清除对应属性；groupId 会替代旧 group 文本。", schema: z.object({ ...guarded, changes: changes.optional(), body: text.optional() }).strict().refine(input => input.body !== undefined || (input.changes && Object.keys(input.changes).length > 0), "至少提供一项修改") },
  { name: "MaterialBindComponent", description: "为实体或地图添加／更新组件；componentPath 指向组件资料，values 合并已有值和默认值，验证字段与类型。", schema: z.object({ ...guarded, componentPath: path, values: values.optional() }).strict() },
  { name: "MaterialUnbindComponent", description: "从实体或地图移除指定 componentId 的组件绑定，保留其他组件和正文。", schema: z.object({ ...guarded, componentId: path }).strict() },
  { name: "MaterialSetImage", description: "设置资料配图：sourcePath 导入项目内 PNG/JPEG/WebP/GIF（最多 2 MiB）；imagePath 复用已导入图片；remove=true 清除。三个选项必须仅提供一个。", schema: z.object({ ...guarded, sourcePath: path.optional(), imagePath: z.string().regex(materialImagePath).optional(), remove: z.literal(true).optional() }).strict().refine(input => Number(input.sourcePath !== undefined) + Number(input.imagePath !== undefined) + Number(input.remove === true) === 1, "必须选择一种配图操作") },
];
