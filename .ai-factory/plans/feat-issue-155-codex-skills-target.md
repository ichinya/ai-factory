# Implementation Plan: Issue #155 — каталог навыков Codex и безопасная миграция

Branch: feat/issue-155-codex-skills-target
Base branch: 2.x
Base commit: e144f95c89de0d0cb6c9b38dbe8c2907b00dc5ce
Created: 2026-09-07
Updated: 2026-09-07 — aif-improve
Status: planned
Mode: full

## Original Request

default

## Request Context

План продолжает запрос пользователя «$aif-explore issue #155» и последующую команду «$aif-plan full default». В Original Request сохранён точный остаток последней команды после удаления распознанного mode token full. Слово default трактуется как выбор стандартных настроек планирования; предмет работы остаётся issue #155.

Существующая ветка уже подготовлена для этой issue и совпадает с локальной 2.x на указанном commit. Использовать её без создания второй ветки, переключения checkout или pull. HANDOFF_MODE и связанные переменные не заданы; Handoff sync не требуется. Режим --parallel не запрошен.

## Settings

- Testing: yes
- Logging: verbose
- Docs: yes
- Language: russian; technical terms, identifiers и commands сохранять на English.
- Plan ID format: slug.
- Preferences source: пользователь выбрал default; tests/docs включены, roadmap linkage пропущен.
- Docs policy: обязательный checkpoint через $aif-docs; обновления документации входят в Task 11.
- Logging control: подробные диагностические сообщения включаются через LOG_LEVEL=debug по существующему образцу src/core/extensions.ts; штатный вывод CLI остаётся кратким.
- Task tracking: TaskCreate/TaskUpdate отсутствуют в текущем runtime; чекбоксы и Depends on ниже являются локальным реестром задач. Внешнюю систему задач не использовать.
- Scope: планирование завершает текущую команду; реализация начинается отдельным $aif-implement.

## Roadmap Linkage

Milestone: "none"
Rationale: Пропущено при выборе default; существующий roadmap не содержит отдельного milestone для исправления каталогов Codex. Отсутствие linkage само по себе — WARN, а не блокирующая ошибка проверки.

## Source Context

- Issue: https://github.com/lee-to/ai-factory/issues/155
- Title: fix(codex): prefer existing .agents/skills and preserve .codex configuration and agents
- Live state при планировании: open; updated_at: 2026-09-06T09:13:15Z; comments: 0.
- Проверенный checkout: package version 2.19.0, commit указан в шапке.
- При aif-improve повторно выполнен fetch origin/upstream: default branch обоих remotes — 2.x; локальные 2.x и feat/issue-155-codex-skills-target совпадают с upstream/2.x на e144f95. Origin/2.x остаётся на a3cfacc и отстаёт на 20 коммитов. Новых upstream-коммитов для переноса нет; branch switch/merge/push не выполнялись.
- Источник решений: текст issue и исследование в текущей беседе. Рекомендация автоматически объединять CLI/App уже при первом init пустого проекта отдельно не принята; этот план сохраняет defaults из issue.
- Текущая официальная документация: https://learn.chatgpt.com/docs/build-skills — обнаружение .agents/skills и отсутствие объединения по одинаковому name; https://learn.chatgpt.com/docs/agent-configuration/subagents — проектные .codex/agents и .codex/config.toml. Проверено через Context7 и официальные страницы в исследовании.

## Research Context

Source: none.

Настроенный research artifact прочитан, но посвящён Unified config.yaml и датирован 2026-03-26. Он не используется как источник требований этого плана. Не переносить его Active Summary в задачи issue #155. Неперсистированное исследование текущей беседы сохранено в Source Context, контрактах и Code Evidence ниже; отдельный research artifact не создаётся.

## Goal and Scope

Выбирать фактический каталог навыков Codex по структуре проекта, последовательно использовать его для файлов, шаблонов и extensions, сохранять выбор в .ai-factory.json и безопасно консолидировать доказуемо управляемые копии.

В scope: src/core, lifecycle handlers init/update/upgrade/extension, существующие smoke tests и пользовательская документация. Runtime config, agent files и MCP обслуживаются отдельно от каталога skills.

Вне scope: изменение глобальных каталогов пользователя; переименование runtime IDs; изменение defaults остальных клиентов; отключение plugins; гарантированное исчезновение предупреждения о skills context budget; автоматическое разрешение конфликта codex/universal; редактирование source skills ради замены путей, которые должен подставлять installer; общий rewrite системы migrations или logging.

Наличие untracked subagents/*.md и skills/aif-distillation/scripts/__pycache__/ зафиксировано до работы. Эти файлы не относятся к issue: не удалять, не переносить, не включать в коммиты. Сам план расположен под существующим gitignore для .ai-factory/; его локальная запись не означает публикацию или включение в Git.

## Behavioral Contracts

### C1. Выбор каталога

Определять назначения всех участников один раз по состоянию до первой записи команды. Созданная ранее в том же цикле папка другого клиента не должна менять результат для следующего клиента.

| Исходное состояние проекта | Effective skillsDir для codex |
| --- | --- |
| Есть каталоги .agents и .codex | .agents/skills |
| Есть каталог .agents, включая пустой без skills | .agents/skills |
| Есть только каталог .codex | .codex/skills |
| Нет обоих каталогов | Текущий registry default: .codex/skills |
| Уже сохранён .agents/skills | Сохранить путь, даже если папку нужно восстановить |
| Сохранён иной пользовательский skillsDir | Сохранить явный override; автоматический перенос ограничен известным legacy .codex/skills |

Для codex-app сохраняется .agents/skills. На первом init полностью пустого проекта с выбранными CLI и App сохраняются их текущие раздельные defaults независимо от порядка выбора. При следующей mutating-команде наличие .agents может запустить безопасную миграцию CLI по тому же правилу. Это сознательное следствие требования о defaults, а не обещание устранить все дубликаты уже при первом init.

Использовать проверку типа directory; файл с именем .agents не считать каталогом. При недоступном или небезопасном target сообщать ошибку с путём, не переключаться молча на другой target. Нормализовать Windows separators, относительные aliases и сравнение физических каталогов; symlinks/junctions требуют отдельного учёта до операций удаления.

Для отсутствующего destination определять физический target через ближайшего существующего предка, затем повторно проверять границы перед записью. Если source и destination обозначают один физический каталог, это не перенос данных: допустимы согласование metadata и проверенный re-render, но запрещена очистка «старой копии». Отклонять ancestor/descendant overlaps между source, destination, другим skill target, native asset roots и staging/recovery roots до mutation. Например, target .agents/skills/aif внутри другого target .agents/skills нельзя считать независимой установкой.

### C2. Installation context и общий результат

Не менять глобальный registry в зависимости от filesystem. Передавать immutable effective context в запись skills, рендеринг SKILL.md, markdown references и команды запуска вспомогательных scripts.

Разделить runtime asset config и skill rendering context. Для singleton target сохранить существующие registry metadata выбранного runtime, переопределяя только фактическое размещение skills; в частности, codex-app отдельно не должен получать новый --agent codex, config_dir=.codex или другое имя клиента из-за этой issue.

Только для действительно общего target codex+codex-app определить стабильный shared render profile: config_dir=.codex, settings_file=.codex/config.toml, agent_name=Codex, skills_cli_agent_flag=--agent codex; project/home variables разрешаются явно для этого профиля. Этот профиль влияет на текст навыков, но не включает MCP или agent-file capabilities у codex-app и не меняет runtime configDir в registry. При переходе shared → singleton или обратно пересчитать profile/fingerprint и выполнить проверенный re-render, даже если package sourceHash прежний. Прямой вызов installSkills/installExtensionSkills без явно переданного group context использует singleton semantics.

Не выводить глобальное размещение из произвольного project override: для штатных .codex/skills и .agents/skills сохранить существующий home convention; для custom project target project paths должны вести в этот target, а home fallback определяется отдельно из runtime profile. Не создавать строки вида ~/D:/... или трактовать custom project directory как установленный глобальный skill root. В template pipeline учитывать существующую форму ~/{{skills_dir}} как home-scope ссылку наравне с {{home_skills_dir}} до обычной подстановки project skills_dir; для штатных путей rendered output остаётся прежним. Сохранение custom override относится к поддерживаемым project-relative paths; эта issue не добавляет поддержку absolute/external targets, небезопасный путь отклоняется до записи.

Сохранить CodexTransformer и $aif-* invocations, пути к scripts и относительные ссылки. Проверять полный rendered output, а не только transformer identity. Для других runtime families сохранить текущие profiles.

Для обнаружения изменения effective context при неизменном package source добавить optional renderContextHash только в managed skill receipts .ai-factory.json; loadConfig/normalization/save сохраняют поле обратно совместимо. ManagedArtifactState/normalization также используются agent files и config files: их существующий hash contract не расширять поведением, специфичным для skills. Fingerprint включает версию render contract, transformer/render profile и эффективные template variables. Старые sourceHash/installedHash не менять по смыслу. Отсутствующий fingerprint не разрешает переписать неизвестную копию: для migration действуют доказательства C3; при известном управляемом baseline выполнить необходимый re-render и только затем записать новый fingerprint.

Группировать физические операции по target и совместимому render profile: объединять нужные skill sets, писать каждый skill и injection один раз, отражать результат во всех участвующих runtime records. Один участник не может удалить навык, который нужен другому. Не сокращать agents array ради deduplication: agent/config/MCP assets и отчётность остаются runtime-specific.

До deduplication определить владельца каждого конечного relative skill path: bundled skill либо extension name + manifest skill path + source revision. Одинаковый basename и совместимый renderer не означают одного владельца. Один source у нескольких runtime entries устанавливается один раз; competing extension custom skills и пересечение custom skill с bundled skill блокируются до записи. Перекрытие bundled skill разрешено только через явный manifest.replaces с существующей проверкой replacement conflicts. Для уже совместимых общих targets применять тот же ownership preflight, даже если физического переноса сейчас нет; не расширять это в отдельный общий redesign extensions.

Codex + universal на одном target — явная ошибка до изменения установки. Проверка обязательна также для extension mutation entrypoints и после изменения prospective runtime definitions. Read-only extension list не должен запускать миграцию.

### C3. Сохранность при миграции

Разделять два вида evidence:

- Нормализованные managed hashes для обычного update: Markdown normalization и удаление injection blocks остаются совместимыми с существующим state.
- Raw byte digests и полный filesystem inventory для сравнения копий, rollback и разрешения удаления. Одинаковые managed hashes не доказывают одинаковые injections или сохранность неизвестных файлов.

Preflight учитывает installedSkills, managedSkills, extension custom skills, replacements и injection manifests, а также обе реальные копии. Нехватка hashes, старого source или extension manifest означает неизвестную provenance. Нельзя вычислить hash произвольного существующего файла и объявить его чистым managed baseline.

Автоматически переносить/консолидировать только содержимое с доказанной provenance. Разницу, полностью объясняемую проверенным старым/новым render context, разрешать через ожидаемые rendered trees. Реальные локальные изменения, отличающиеся injections и неизвестные конфликтующие файлы сохранять и выдавать конкретный conflict с обоими путями; до пользовательского разрешения операция не меняет установку. Новую интерактивную merge UI или молчаливый выбор «победителя» не вводить.

Неизвестные файлы, custom skill directories и пустые пользовательские directories не удалять. При нехватке provenance либо сохранённом custom skill дубликаты могут остаться; показывать это как неразрешённый остаток, а не как успешное полное устранение дубликатов. --force не обходит защиту миграции.

### C4. Transaction и восстановление

Выделить ограниченную транзакцию переноса skills. Staging, raw backups и recovery journal хранить вне skill discovery roots, например в .ai-factory/skill-migrations/<operation-id>/; это CLI runtime state, не workflow research/plan artifact. Journal содержит состояние операции, относительные пути, digest evidence и old/new config snapshots, без логирования содержимого.

Порядок: inspect → stage final skills composition → verify destination → commit destination и atomic config replacement → verify → cleanup только подтверждённых старых managed entries. До фиксации config исходные bytes должны оставаться восстановимыми. Не удалять каталог .codex целиком.

При ошибках copy/render/injection/config save восстанавливать затронутые bytes и прежний config либо оставлять явный recoverable state с backup. При process interruption следующая mutating-команда сначала проверяет journal/digests и завершает или откатывает именно записанную операцию. Если файлы изменились после preflight, прекращать destructive step. Повторное восстановление идемпотентно; ошибка rollback не удаляет recovery material.

Применять атомарную замену только необходимого config/операционного state; не переписывать все filesystem helpers проекта. Блокировать конкурентную миграцию тех же targets либо обнаруживать её до commit.

Атомарный rename не защищает от потери параллельных изменений config. На время migration/recovery все mutating entrypoints должны учитывать project-level migration lock; до config commit и rollback сравнивать raw digest .ai-factory.json с ожидаемой ревизией, включая отсутствие файла при первоначальном init. При несовпадении сохранить чужую правку и recovery material, сообщить conflict. Rollback может заменить только bytes, для которых доказано, что это результат данной операции; старый snapshot не должен затирать последующее изменение пользователя или другого процесса. Journal version, phase, пути и digest evidence перепроверяются при resume.

Граница транзакции — skills и относящиеся к ним поля config. Подготовить отдельный clone config; skills-only commit не должен менять native ownership через побочный hydrateAgentFileSources: использовать существующий saveConfig option hydrateAgentFileSources=false либо эквивалентный узкий writer. Existing configFile/agentFile state, runtime MCP preferences и extension source/version records остаются неизменными в этой транзакции.

Закончить или восстановить миграцию по snapshot уже установленной composition до обычного обновления native assets и до установки/удаления версии extension. Pure prospective compatibility checks допустимы заранее. После migration commit перечитать config и продолжить исходную init/update/upgrade/extension операцию с актуальным состоянием. Если её последующий native/extension шаг завершился ошибкой, сообщить её отдельно; не откатывать уже завершённую миграцию старым полным config snapshot. Не требуется транзакционность всех native/MCP operations ради этой issue.

### C5. Lifecycle и native assets

Для операций, затрагивающих перенос/общий target, итоговая композиция одинакова: selected base skills → extension replacements/custom skills → injections → итоговые managed hashes → сохранение config → разрешённая очистка источника.

Для отдельной migration transaction это композиция уже установленной ревизии, прошедшая preflight; для последующего обычного lifecycle — композиция запрошенного обновления. Не смешивать в одном receipt новый extension version и ещё не обновлённые native assets. Ошибка или недоступность нужного source до миграции обрабатывается по C3, а не частичным refresh.

init и upgrade должны учитывать эту композицию; текущей установки built-ins с последующим применением только injections недостаточно. Extension refresh/replacement rollback должен восстанавливать общий target один раз и сохранять результаты для каждого участника.

При переносе не изменять .codex/config.toml, .codex/agents и их ownership metadata. Обычный независимый lifecycle native assets сохраняет существующую политику, включая сохранение пользовательского config при --force.

При снятии runtime через init сохранять общий skills target и пользовательские файлы оставшихся участников. Не удалять .codex/config.toml, если его продолжает использовать codex-app; проверять физическое использование settingsFile/configFiles, а не только installedConfigFiles снятого runtime. Удаление собственных native agent files при явном снятии CLI следует существующей ownership policy и не должно затрагивать чужие assets.

## Code Evidence

Номера строк относятся к исходному commit; при реализации ориентироваться прежде всего на symbols.

| Место | Подтверждённый факт / точка изменения |
| --- | --- |
| src/core/agents.ts:68–89 | codex и codex-app имеют разные skillsDir и template metadata; native Codex assets находятся под .codex |
| src/core/config.ts:240–284 | loadConfig сохраняет explicit skillsDir; missing managed state нормализуется в пустой объект |
| src/core/template.ts:14–35 | buildTemplateVars/processSkillTemplates используют AgentConfig |
| src/core/installer.ts:691–751, 856–870 | target берётся из аргумента, template context — из static getAgentConfig |
| src/core/transformer.ts:130–195 | assertCompatibleSkillTargets сравнивает transformer identities по строковому target |
| src/core/installer.ts:160–213, 379–447 | managed hashes нормализуют Markdown и исключают injections |
| src/core/installer.ts:1050–1067 | missing managed state и local drift приводят к reinstall |
| src/cli/commands/init.ts:99–147, 178–248 | удаления и установки выполняются по runtime; удаляется весь skillsDir |
| src/cli/commands/init.ts:269–303 | после built-ins повторно устанавливаются extension agent files и injections, но не полная skill composition |
| src/cli/commands/update.ts:226–284, 313–459 | guard, refresh, per-runtime writes, replacements, injections, final hashes |
| src/cli/commands/upgrade.ts:132–259 | legacy mutations происходят без общего target guard; extension composition не восстанавливается |
| src/core/extension-ops.ts:75–127, 424–562, 578–771 | повторные writes/removes/rollback и replacement success counts привязаны к runtime entries |
| src/core/injections.ts:28–57, 197–215 | markers заменяются идемпотентно; fallback cleanup сканирует static configDir |
| src/utils/fs.ts:98–156; src/core/config.ts:366 | raw directory hash пропускает symlinks/пустые dirs; config writer не использует atomic rename |
| src/core/config.ts:18–40, 123–148, 366–377 | Один managed hash type/normalizer используется для разных artifacts; saveConfig по умолчанию гидратирует native agent ownership |
| src/core/extension-ops.ts:403–418, 703–771 | Replacement guard проверяет manifest.replaces, а не все basename collisions; extension source/native assets меняются до внешнего saveConfig |
| src/cli/commands/update.ts:313–330 | Skill updates сейчас перемежаются с native asset updates; для migration boundary потребуется явное разделение |
| .ai-factory/patches/2026-05-16-13.41.md; 2026-06-16-22.16.md | Проверять реальные Node-visible junctions/symlinks; при отсутствии capability сохранять deterministic boundary coverage |

## Tasks

### Phase 1: Контракт назначения и preflight

- [ ] Task 1: Подготовить регрессионные fixtures и проверки исходной проблемы.
  Deliverable: воспроизводимые temp-project сценарии для пустой .agents, обоих каталогов, direct install с override и неверных template links. Добавить raw snapshot helper для последующих custody assertions; сохранять одни и те же checks для проверки исправления. Разделить core и CLI scenario groups в отдельном runner: CLI cases сначала запускаются явно как ожидаемые failing regressions, а в штатные smoke suites подключаются вместе с готовой CLI-интеграцией в Tasks 8–10.
  Files: scripts/test-codex-skill-targets.mjs (new), scripts/test-extension-fixtures.sh; изменения вызовов в scripts/test-init.sh/test-update.sh/test-extensions.sh выполняются при соответствующей интеграции.
  Acceptance: до исправления выбранные opt-in regression checks падают по ожидаемой причине, существующие control cases проходят; fixtures не используют текущую рабочую установку, сеть или модель. Стандартные suites не получают заведомо падающие CLI cases до подключения реализации; core checks подключать по мере завершения Tasks 2–4.
  Logging: выводить scenario/command/path и конкретное failed assertion; не печатать содержимое config или навыков целиком. Production logging не добавляется.
  Depends on: none.

- [ ] Task 2: Реализовать единый resolver effective skill targets и групп участников.
  Deliverable: core-модуль src/core/skill-targets.ts с разрешением C1, immutable context, filesystem snapshot до writes, сохранением persisted overrides, физической нормализацией targets и типизированными причинами выбора. Отдельно сохранить static runtime asset config.
  Files: src/core/skill-targets.ts (new), src/core/agents.ts, src/core/transformer.ts, src/core/config.ts только при необходимости типов/совместимого чтения.
  Acceptance: вся таблица C1; оба порядка CLI/App дают одинаковые назначения; сохранённый общий путь не откатывается; пользовательский override и non-Codex defaults сохранены; .agents-файл/unsafe alias не принимается как безопасный каталог. Same-physical-target не запускает source cleanup; ancestor/descendant overlaps отклоняются, включая отсутствующий target под существующим alias.
  Logging: DEBUG [skill-targets] runtime IDs, previous/effective target, reason и group membership; INFO только при реальной смене target; ERROR с конкретным path при недопустимом назначении. Использовать LOG_LEVEL и существующий callback pattern.
  Depends on: Task 1.

- [ ] Task 3: Передать согласованный render context во все skill installers.
  Deliverable: реализовать C2 в installSkills/installExtensionSkills/installSkillWithTransformer и template pipeline; отделить подготовку rendered content от записи, чтобы migration могла подготовить результат в staging с финальными template paths. Проверять совместимость полного render profile и сохранять отдельные outcomes участников общего target; передавать renderContextHash через normalization, update decisions и итоговые receipts.
  Files: src/core/skill-targets.ts, src/core/installer.ts, src/core/template.ts, src/core/transformer.ts, src/core/config.ts, src/core/transformers/codex.ts только при необходимом согласовании profile.
  Acceptance: SKILL.md и references используют фактический target; helper commands не ссылаются на старую папку; $aif-* и relative links сохранены. Порядок codex/codex-app на общем target не меняет полный rendered tree. Singleton CLI/App metadata сохраняются; shared/singleton переход инвалидирует renderContextHash. Custom project paths не превращаются в неверные home paths. codex/universal отклоняется, остальные transformers и native hash normalization сохраняют поведение.
  Logging: DEBUG profile/group/skill и deduplicated write decision; не выводить rendered content. Сохранить существующие сообщения install errors, добавив target context.
  Depends on: Task 2.

- [ ] Task 4: Реализовать read-only migration preflight с классификацией конфликтов.
  Deliverable: src/core/skills-migration.ts возвращает planned operations и conflicts по C3 без writes. Inventory через lstat учитывает все entries, links/junctions и empty dirs. Отдельно проверяются base, replacement/custom extension provenance и injection differences. Построить owner map конечных skill paths по C2; source owner conflicts не устраняются выбором первого элемента group.
  Files: src/core/skills-migration.ts (new), src/core/installer.ts для переиспользуемого rendering/hash contract, src/core/extension-ops.ts для inventory metadata, src/utils/fs.ts только для узких reusable primitives.
  Acceptance: raw-identical verified copies разрешаются; modified/unknown/недоступные sources сохраняются; differing injection bytes дают conflict даже при равных managed hashes; missing hashes не превращаются в разрешение overwrite; inventory не выходит за допустимые roots. Два разных extension sources одного basename блокируются; явный корректный replaces остаётся разрешённым.
  Logging: DEBUG классификация и proof reason по относительному path; WARN для сохраняемых неизвестных остатков; ERROR с обоими путями и remediation при конфликте. Не логировать bytes.
  Depends on: Tasks 2, 3.

### Phase 2: Миграция и основной lifecycle

- [ ] Task 5: Реализовать применение и восстановление транзакции переноса.
  Deliverable: apply/resume/rollback операции C4, ограниченный journal/staging, byte backups, digest recheck, atomic config replacement и очистка только перечисленных verified entries. Добавить project migration lock и config revision check перед commit/rollback. Skills-only сохранение выполняется без native ownership hydration; сохранять старый normalized hash contract, обновляя итоговый state после полной проверенной composition установленной ревизии.
  Files: src/core/skills-migration.ts, src/core/config.ts, src/utils/fs.ts; src/core/installer.ts для строгого результата staging.
  Acceptance: ошибки copy/render/config save не теряют исходные данные; interruption до/после config commit восстанавливается; retry cleanup безопасен; concurrent edits файлов или .ai-factory.json останавливают destructive step; --force не снимает migration guard. Partial install warnings не могут считаться успешной транзакцией. Save/rollback не гидратируют native metadata и не перезаписывают чужую config revision.
  Logging: INFO начало/завершение миграции, targets и счётчики; DEBUG phases/digest checks; WARN pending cleanup/recovery; ERROR failure/rollback context и путь к recovery material. Verbose detail управляется LOG_LEVEL.
  Depends on: Task 4.

- [ ] Task 6: Интегрировать extensions и injections с общими targets.
  Deliverable: guard mutating extension add/update/remove и commitResolvedExtension после prospective runtime hydration; группировать install/remove/restore/rollback и injections по physical target. Проверять owner map, а не только transformer identity и replaces. Migration завершать до commitExtensionInstall/removePreviousExtensionState/removeExtensionFiles, затем перечитывать config; не запускать вложенную migration из уже начатого extension rollback. Проецировать replacement outcomes на всех участников, сохранив корректные successCount/agentCount. Fallback stripping использует actual skillsDir плюс необходимые flat-artifact roots.
  Files: src/cli/commands/extension.ts, src/core/extension-ops.ts, src/core/injections.ts, src/core/installer.ts, src/core/skill-targets.ts.
  Acceptance: add → update → remove и replacement rollback работают на общем каталоге; prepend/append markers единственные, counters не удвоены; отсутствующий manifest не оставляет удаляемые markers в перенесённых skills; несовместимость обнаруживается до installed asset mutations; extension list остаётся read-only.
  Logging: DEBUG physical operation и projected runtime outcomes; INFO реальные install/injection counts; WARN missing provenance; ERROR conflicting runtime IDs/target или rollback failure. Не менять MCP logging policy.
  Depends on: Tasks 3, 5.

- [ ] Task 7: Защитить общие assets при снятии runtime и удалении skills.
  Deliverable: ownership-aware removeAgentSetup и shared skill removals. Сначала вычислять surviving consumers и required skill union; сохранять используемый target, unknown/custom bytes и общие settings files. Удалять только разрешённые managed entries, а не общий skillsDir целиком.
  Files: src/cli/commands/init.ts, src/core/skill-targets.ts, src/core/installer.ts, src/core/extension-ops.ts.
  Acceptance: helper-level fixtures с явно переданным resolved survivor inventory подтверждают, что снятие CLI при App и обратный порядок сохраняют нужные навыки; .codex/config.toml остаётся, пока его использует оставшийся runtime; один участник не удаляет skill другого; native cleanup соблюдает ownership policy. End-to-end подключение этих helpers к разрешённым targets и CLI acceptance выполняются в Task 8.
  Logging: DEBUG consumers и решение retain/remove; INFO снятый runtime; WARN сохранённые пользовательские/неизвестные entries; ERROR unsafe path. Не выдавать сохранённый общий target за удалённый.
  Depends on: Tasks 2, 3, 6.

- [ ] Task 8: Интегрировать target preparation и общую композицию в init/update.
  Deliverable: до первой mutation подготовить все selected/surviving/removed targets и recovery; сохранить выбор в installedAgents/config. Использовать готовые extension primitives Task 6 и ownership-aware removal Task 7. Завершать skills migration до native asset writes/extension refresh; перечитывать committed config перед обычной операцией и не возвращать старый snapshot после её отдельной ошибки. Выполнять skill operations по группам, native assets — отдельно. Для migration/shared target восстанавливать replacements/custom extension skills и injections перед hashes/save/cleanup в пределах соответствующей composition C5. Подключить готовые CLI regression cases Task 1 к штатным init/update suites.
  Files: src/cli/commands/init.ts, src/cli/commands/update.ts, src/core/installer.ts, src/core/skill-targets.ts, src/core/skills-migration.ts, scripts/test-init.sh, scripts/test-update.sh.
  Acceptance: init/re-init/update соблюдают C1–C5; repeated update не создаёт .codex/skills и не сообщает ложный drift; изменившийся source/render profile обновляется согласованно; user custom skills и native Codex bytes защищены именно при переносе; selections разных участников учитываются до removal.
  Logging: существующий progress output сохраняется; INFO сообщает фактический skillsDir; DEBUG объясняет shared operations; conflict/recovery приводит к явному nonzero result до опасных writes, а не к общему success.
  Depends on: Tasks 3, 5, 6, 7.

### Phase 3: Upgrade, проверка и документация

- [ ] Task 9: Согласовать upgrade с target guard и extension composition.
  Deliverable: подготовить targets/recovery до legacy rename/remove; применить тот же safe migration path с отдельным commit boundary до обычных native writes; сохранить существующую v1→v2 семантику, восстанавливая актуальные extension replacements/custom skills/injections для затронутого target до итогового state. Подключить соответствующие upgrade regression cases.
  Files: src/cli/commands/upgrade.ts, src/core/skills-migration.ts, src/core/extension-ops.ts, src/core/installer.ts, scripts/test-update.sh.
  Acceptance: legacy codex layout с .agents конвертируется без возрождения второго managed набора; несовместимый shared target блокирует upgrade до первой legacy mutation; extension replacement не заменяется незаметно stock skill; non-Codex upgrade fixtures остаются зелёными.
  Logging: INFO chosen target и upgrade summary; DEBUG legacy/current operation mapping; ERROR конфликт до destructive action с remediation; WARN остающиеся неизвестные legacy entries.
  Depends on: Tasks 5, 6, 8.

- [ ] Task 10: Завершить регрессионное покрытие migration/shared lifecycle.
  Deliverable: расширить исходные checks Task 1 матрицей ниже, включая реальный failure recovery и checks installed bytes/config state. Использовать существующие isolated temp fixtures и offline extension fixtures; не запускать CLI над рабочим проектом.
  Files: scripts/test-init.sh, scripts/test-update.sh, scripts/test-extensions.sh, scripts/test-extension-fixtures.sh, scripts/test-codex-skill-targets.mjs из Task 1.
  Acceptance: все строки Verification Matrix имеют executable coverage; тесты проверяют конечный filesystem/state, а не только строку лога или внутреннюю реализацию. Создавать links через Node fs, используя junction на Windows; проверять lstat().isSymbolicLink() и realpath тем же runtime, которым работает проверяемый код. При недоступной native capability явно отметить непроверенную интеграцию и обязательно выполнить deterministic resolver/boundary-policy checks; plain skip не считается покрытием границ. Windows separator/alias cases обязательны также на другом host.
  Logging: scenario IDs, command results, digest mismatch paths и recovery phase; захватывать LOG_LEVEL=debug только для failing-case диагностики; не выводить секреты из fixtures.
  Depends on: Tasks 5, 6, 7, 8, 9.

- [ ] Task 11: Обновить пользовательские контракты через $aif-docs.
  Deliverable: документировать таблицу выбора, persisted overrides, defaults пустого проекта, совместимость CLI/App и конфликт Universal, порядок безопасной миграции и конкретное действие при unresolved conflicts/recovery. Уточнить, что перемещение skills не меняет native asset paths и не гарантирует исчезновение budget warning.
  Files: docs/getting-started.md, docs/configuration.md, docs/subagents.md, docs/extensions.md; README.md и AGENTS.md только если их краткие сведения требуют согласования.
  Acceptance: docs соответствуют итоговой реализации; нет инструкции удалить всю .codex; отсутствует обещание автоматического merge локальных правок. Описать singleton/shared render behavior, config-conflict recovery и границу завершённой миграции при ошибке последующего update. Обновить существующие неточные формулировки о перезаписи пользовательского Codex config в затронутых абзацах согласно фактической policy. Не менять unrelated roadmap/research/context artifacts.
  Logging: runtime logging не добавляется; документация объясняет LOG_LEVEL=debug и реальные диагностические сообщения. Зафиксировать docs checkpoint как выполненную задачу, без отдельного отчёта.
  Depends on: Tasks 6, 7, 8, 9, 10.

- [ ] Task 12: Выполнить итоговую квалификацию изменения.
  Deliverable: выполнить Verification Commands, проверить final diff, task coverage, отсутствие unrelated/staging artifacts в коммитах и восстановление повторного запуска на fixtures. Отметить задачи выполненными только по результатам реально выполненных checks.
  Files: изменённые source/tests/docs и этот plan file для progress; отдельный report file не создавать.
  Acceptance: build, affected lifecycle checks и полный npm test проходят; исходные untracked файлы сохранены; unresolved custody/compatibility failures отсутствуют. Непроверенные платформенные сценарии явно перечислены в handoff и не выдаются за PASS.
  Logging: кратко указать команды, результат и material limitations; не дублировать полный test output.
  Depends on: Tasks 10, 11.

## Verification Matrix

| ID | Сценарий | Ожидаемое evidence |
| --- | --- | --- |
| V01 | Обе папки / только .agents / только .codex / ни одной / пустая .agents | Таблица C1; config.skillsDir и actual location совпадают |
| V02 | Пустой проект CLI+App в обоих порядках | Сохраняются defaults первого init; следующий update применяет migration по существующей структуре |
| V03 | Persisted .agents/skills с отсутствующей папкой; explicit custom path | Общий target восстанавливается, override сохраняется |
| V04 | Direct base/extension install в override target; context change при прежнем sourceHash | Верные SKILL.md/references/helper paths, $aif-* и relative links; необходимый re-render и совместимые receipts |
| V05 | Общий codex+codex-app, обратный порядок, разные installedSkills | Идентичный rendered tree, required union, согласованные per-runtime outcomes |
| V06 | codex/universal: init/update/upgrade/extension add/update/remove | Nonzero conflict до installed file/config mutations; снимки bytes не изменились |
| V07 | Verified raw-identical копии; различие только expected render paths | Управляемые копии безопасно консолидируются, metadata согласована |
| V08 | Local edits / injection-only differences / неизвестный файл внутри skill | Различия обнаружены по raw bytes; сохранность обеих копий; no silent overwrite |
| V09 | Missing hashes/old source/extension manifest; custom skill, empty dir, junction | Provenance не выдумана; unknown data сохранены; links не обходят roots |
| V10 | Copy/render/injection/config-save failure; concurrent file/config edit | Старые bytes/config сохранены либо восстановимы; чужая config revision не затирается commit/rollback; никакого ложного success |
| V11 | Process interruption до commit, после config commit, во время cleanup; ошибка native update после миграции | Journal recovery идемпотентен; повтор не принимает partial state за clean baseline; завершённая миграция не откатывается после отдельной native ошибки |
| V12 | Update повторно и --force после успешного переноса | Нет возвращения .codex/skills managed duplicates; нет false drift; migration custody не обходится |
| V13 | Extension replacement+custom skill+prepend/append: add/update/re-init/upgrade/remove | Полная composition, один marker на позицию, правильное base restore |
| V14 | Replacement partial failure/rollback; remove без manifest | Восстановлены правильные shared bytes/outcomes; markers убраны с actual target |
| V15 | Снять CLI при App / снять App при CLI; удалить skill одного участника | Shared/custom assets и используемый .codex/config.toml сохранены |
| V16 | Native Codex config/agents + другие клиенты во время переноса | Byte snapshots и ownership records сохранены в пределах migration |
| V17 | Existing Claude/Universal/Antigravity/Qwen и extension-runtime fixtures | Их defaults, invocation styles, flat layout и lifecycle не регрессируют |
| V18 | Same physical target через alias; nested targets; overlap со staging/native roots | Alias не очищается как отдельный source; nested/unsafe overlaps блокируются до writes |
| V19 | Два extension custom skills одного basename; custom против bundled; explicit replaces | Competing owners блокируются; shared одинаковый source deduplicated; корректный replaces работает |
| V20 | Singleton CLI/App → shared target → singleton; custom project path | Metadata singleton не меняются без shared membership; переход обновляет profile/receipts; home paths корректны |

Native filesystem части V09/V18 сопровождаются capability evidence; deterministic boundary checks обязательны и при отсутствии native symlink прав.

## Verification Commands

Команды ниже предназначены для реализации; при создании плана они не запускались.

~~~powershell
npm run build
npm run test:init
npm run test:update
npm run test:extensions
npm run lint:unused
npm test
git diff --check
git status --short
~~~

Focused suites выполнять при изменении соответствующего слоя. Полный npm test выполнить один раз на итоговой реализации: он уже включает основные lifecycle suites; не повторять их после полного PASS без новых изменений или отдельной причины. Не выполнять npm link, ai-factory update или destructive cleanup над текущим checkout ради проверки.

## Commit Plan

- Commit 1, после Tasks 1–4: "fix(codex): resolve skill targets and preflight migration". Проверить завершённые core scenario groups и прежние штатные suites; CLI regression group пока запускается отдельно и не подключена к ним. Не представлять этот checkpoint как завершение issue.
- Commit 2, после Tasks 5–8: "fix(codex): migrate and preserve shared skills during lifecycle operations". Migration, extensions, ownership и подключённые init/update regressions должны пройти на isolated fixtures.
- Commit 3, после Tasks 9–12: "fix(codex): complete upgrade coverage and document skill migration". Upgrade, финальная матрица и полный suite должны пройти перед публикацией.

Checkpoints определяют границы будущих коммитов; данный запуск планирования не выполняет commit/push/PR и не меняет Git ignore policy.

## Refinement — 2026-09-07

Пользователь подтвердил применение всех улучшений. Сохранены Original Request, Settings, 12 задач, их зависимости и 3 commit checkpoints. Уточнены пять связанных областей: ограничение shared renderer и home-path semantics; owner/root collision preflight; config revision/lock и skills-only transaction boundary; skill-specific fingerprint normalization; portable filesystem coverage. Матрица расширена с 17 до 20 сценариев. Реализация и тестовые прогоны не выполнялись; проверены план и актуальность base branch.
