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
const groupNode = z.object({ id: z.string().trim().min(1).max(200).optional(), name: z.string().trim().min(1).max(100), parentId: z.string().trim().min(1).max(200).optional(), order: z.number().int().optional() }).strict();
const materialGroups = z.partialRecord(category, z.array(groupNode).max(1000));
const changes = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: text.optional(),
  group: z.string().trim().max(100).nullable().optional(), groupId: z.string().trim().min(1).max(200).nullable().optional(), parent: path.nullable().optional(), extends: path.nullable().optional(),
  scope: z.enum(["system", "user"]).optional(),
  type: z.enum(["entity", "character", "enemy", "map", "system", "item", "event", "component", "setting", "ui", "spec", "feature", "decision"]).optional(),
  status: z.string().trim().min(1).max(100).optional(), version: z.union([z.number().int().positive(), z.string().min(1).max(100)]).optional(),
  source: z.string().min(1).max(200).optional(), relations: z.array(path).max(256).optional(),
  fields: z.array(field).max(256).optional(), entities: z.array(path).max(256).optional(),
  dependsOn: z.array(z.string().trim().min(1).max(200)).max(64).optional(),
  systems: z.array(path).max(256).optional(),
  affectedSystems: z.array(path).max(256).optional(),
  supersedes: z.string().trim().min(1).max(200).optional(),
  components: z.array(z.object({
    id: path, values: values.optional(),
    mount: z.object({ parent: z.string().min(1).max(200), anchor: z.string().min(1).max(80) }).strict().optional(),
  }).strict()).max(256).optional(),
  stateMachine: StateMachineSchema.nullable().optional(),
  materialGroups: materialGroups.optional(),
}).strict();
const crop = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) }).strict()
  .refine(area => area.x + area.width <= 1 && area.y + area.height <= 1, "裁剪区域必须位于图片范围内");
const guarded = { path, expectedVersion: VersionTokenSchema.refine(version => version !== "absent", "先 MaterialRead 获取已有资料版本") };

export const materialToolDefinitions: WorkTool[] = [
  { name: "MaterialsList", description: "查询应用内实体、组件、地图、设定、UI、规范资料；可按类别、稳定分组 ID（包含后代）、实体类型和关键词组合筛选，并返回层级分组树、路径、摘要与版本。旧 group 文本筛选仍可用。", initial: true, schema: z.object({ category: category.optional(), query: z.string().max(2000).optional(), group: z.string().max(100).optional(), groupId: z.string().trim().min(1).max(200).optional(), entityType: z.enum(["entity", "character", "enemy", "item", "system", "event"]).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(100).optional() }).strict() },
  { name: "MaterialRead", description: "读取应用内资料的元数据、正文、完整内容和版本。组件资料返回继承合并后的有效 fields（自身字段覆盖同名基类字段）。后续修改必须携带返回的 expectedVersion。", initial: true, schema: z.object({ path }).strict() },
  { name: "MaterialCreate", description: "按名称创建并立即保存资料；category 支持 entity/component/map/setting/ui/spec，省略 id 自动生成。properties 可定义组件字段、scope（system/user）、稳定 groupId、父级与继承（组件 extends 组件）；不创建智能体任务。", schema: z.object({ category, title: z.string().trim().min(1).max(200), id: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(), body: text.optional(), properties: changes.omit({ title: true }).optional() }).strict() },
  { name: "MaterialUpdate", description: "保存资料名称、说明、scope、稳定 groupId、父级、继承、组件字段或正文；必须先读版本。groupId/parent/extends=null 清除对应属性；groupId 会替代旧 group 文本。组件可用 extends 指向另一个组件，字段按继承链合并、同名自身字段覆盖基类；实体 extends 仍只指向实体。项目资料 specs/project.md 还可用 changes.materialGroups 覆盖指定类别的分组树；省略 id/order 时自动生成，父组需引用同次提交的 id。", schema: z.object({ ...guarded, changes: changes.optional(), body: text.optional() }).strict().refine(input => input.body !== undefined || (input.changes && Object.keys(input.changes).length > 0), "至少提供一项修改") },
  { name: "MaterialBindComponent", description: "为实体或地图添加／更新组件；componentPath 指向组件资料，values 合并已有值、组件继承后的字段和默认值，验证字段与类型。", schema: z.object({ ...guarded, componentPath: path, values: values.optional() }).strict() },
  { name: "MaterialUnbindComponent", description: "从实体或地图移除指定 componentId 的组件绑定，保留其他组件和正文。", schema: z.object({ ...guarded, componentId: path }).strict() },
  { name: "MaterialSetImage", description: "设置资料配图：sourcePath 导入项目内 PNG/JPEG/WebP/GIF，imagePath 复用已导入图片；crop 以归一化 {x,y,width,height}（0~1）裁剪后再保存，GIF 可能含动画不能裁剪。超过 2 MiB 的 PNG/JPEG（含裁剪结果）在桌面端会自动压缩；remove=true 清除。sourcePath/imagePath/remove 必须仅提供一个。", schema: z.object({ ...guarded, sourcePath: path.optional(), imagePath: z.string().regex(materialImagePath).optional(), crop: crop.optional(), remove: z.literal(true).optional() }).strict()
    .refine(input => Number(input.sourcePath !== undefined) + Number(input.imagePath !== undefined) + Number(input.remove === true) === 1, "必须选择一种配图操作")
    .refine(input => input.crop === undefined || input.sourcePath !== undefined || input.imagePath !== undefined, "crop 只能与 sourcePath 或 imagePath 一起使用") },
];
