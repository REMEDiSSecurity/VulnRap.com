export type Language = "es" | "de" | "ja" | "ru" | "pt" | "ar";
export type Variant = "legit" | "slop";

export interface MultilingualFixture {
  id: string;
  language: Language;
  variant: Variant;
  text: string;
}

export const TIER_ORDER = [
  "Clean",
  "Likely Human",
  "Questionable",
  "Likely Slop",
  "Slop",
] as const;

export type Tier = (typeof TIER_ORDER)[number];

export function tierIndex(tier: string): number {
  const i = TIER_ORDER.indexOf(tier as Tier);
  return i === -1 ? -1 : i;
}

export const ENGLISH_LEGIT = `Title: Stored XSS in /admin/comments via the "title" field
Affected: example-app v2.4.1, commit a1b2c3d, file src/admin/comments.js line 142.

Steps to reproduce:
1. Log in as a low-privileged user.
2. POST to /api/comments with title=<svg/onload=alert(1)>.
3. Visit /admin/comments as an admin. The payload executes in the admin's browser.

Root cause: the title field is rendered with innerHTML in renderComment() without escaping. See sanitizeComment() in src/admin/comments.js which only sanitizes the body, not the title.

Impact: an attacker can hijack admin sessions because session cookies are not HttpOnly. Tested on Firefox 124 and Chrome 123. CWE-79.

Suggested fix: pass the title through the existing escapeHtml() helper, or switch renderComment() to textContent for fields that should not contain markup.`;

export const ENGLISH_SLOP = `Hi team,

I am reporting a possible issue in your application that could put users at risk. The problem could let attackers do bad things and harm your users.

Steps to reproduce: send a crafted request to the application. Observe that the input is not properly sanitized. This may allow an attacker to run code as other users.

Impact: This issue could allow remote code execution, data leakage, account takeover and broad compromise of the system.

Reference: https://cwe.mitre.org/data/definitions/79.html

Please consider this report for your bug bounty program.`;

export const FIXTURES: MultilingualFixture[] = [
  {
    id: "es-legit",
    language: "es",
    variant: "legit",
    text: `Título: XSS almacenado en /admin/comments a través del campo "title"
Afectado: example-app v2.4.1, commit a1b2c3d, archivo src/admin/comments.js línea 142.

Pasos para reproducir:
1. Iniciar sesión como usuario con pocos privilegios.
2. Enviar POST a /api/comments con title=<svg/onload=alert(1)>.
3. Visitar /admin/comments como administrador. El payload se ejecuta en el navegador del administrador.

Causa raíz: el campo title se renderiza con innerHTML en renderComment() sin escape. La función sanitizeComment() en src/admin/comments.js solo sanea el cuerpo, no el título.

Impacto: un atacante puede secuestrar sesiones de administrador porque las cookies de sesión no son HttpOnly. Probado en Firefox 124 y Chrome 123. CWE-79.

Solución sugerida: pasar el title por la utilidad existente escapeHtml(), o cambiar renderComment() a textContent para los campos que no deben contener marcado.`,
  },
  {
    id: "es-slop",
    language: "es",
    variant: "slop",
    text: `Hola equipo de seguridad, espero que estén muy bien :)

Me gustaría reportar una posible vulnerabilidad crítica en su aplicación que podría conllevar consecuencias severas. Es importante señalar que este problema podría permitir a atacantes realizar acciones maliciosas y comprometer la seguridad de sus usuarios.

En el ámbito de la seguridad web moderna, el cross-site scripting representa una preocupación de suma importancia en la que las organizaciones deben profundizar de manera integral. Esta vulnerabilidad es multifacética y podría tener implicaciones de gran alcance a través de toda la superficie de ataque de su aplicación.

Pasos para reproducir: enviar una solicitud manipulada a la aplicación. Observar que la entrada no se sanea correctamente. Esto puede permitir a un atacante ejecutar código arbitrario en el contexto de otros usuarios.

Impacto: Esta vulnerabilidad podría permitir potencialmente ejecución remota de código, exfiltración de datos, toma completa de cuentas y compromiso total de la infraestructura subyacente. Es primordial que esto se aborde con la máxima urgencia.

Referencia: https://cwe.mitre.org/data/definitions/79.html

Por favor consideren este reporte para su programa de bug bounty. Quedo a la espera de su respuesta.`,
  },
  {
    id: "de-legit",
    language: "de",
    variant: "legit",
    text: `Titel: Stored XSS in /admin/comments über das Feld "title"
Betroffen: example-app v2.4.1, Commit a1b2c3d, Datei src/admin/comments.js Zeile 142.

Schritte zur Reproduktion:
1. Als Benutzer mit niedrigen Rechten anmelden.
2. POST an /api/comments mit title=<svg/onload=alert(1)>.
3. /admin/comments als Administrator aufrufen. Der Payload wird im Browser des Administrators ausgeführt.

Ursache: Das Feld title wird in renderComment() per innerHTML ohne Escaping gerendert. Die Funktion sanitizeComment() in src/admin/comments.js sanitisiert nur den Body, nicht den Titel.

Auswirkung: Ein Angreifer kann Admin-Sitzungen übernehmen, da die Session-Cookies nicht HttpOnly sind. Getestet mit Firefox 124 und Chrome 123. CWE-79.

Vorgeschlagene Korrektur: Das title-Feld durch den vorhandenen Helfer escapeHtml() schicken oder renderComment() auf textContent umstellen für Felder, die kein Markup enthalten sollen.`,
  },
  {
    id: "de-slop",
    language: "de",
    variant: "slop",
    text: `Hallo Sicherheitsteam, ich hoffe es geht euch gut :)

Ich möchte eine potenziell kritische Schwachstelle in eurer Anwendung melden, die zu schwerwiegenden Folgen führen könnte. Es ist wichtig zu beachten, dass dieses Problem Angreifern erlauben könnte, bösartige Aktionen durchzuführen und die Sicherheit eurer Benutzer zu kompromittieren.

Im Bereich der modernen Web-Sicherheit stellt Cross-Site-Scripting ein vorrangiges Anliegen dar, in das Organisationen umfassend eintauchen müssen. Diese Schwachstelle ist vielschichtig und könnte weitreichende Auswirkungen auf die gesamte Angriffsfläche eurer Anwendung haben.

Schritte zur Reproduktion: Sendet eine präparierte Anfrage an die Anwendung. Beobachtet, dass die Eingabe nicht ordnungsgemäß bereinigt wird. Dies kann es einem Angreifer ermöglichen, beliebigen Code im Kontext anderer Benutzer auszuführen.

Auswirkung: Diese Schwachstelle könnte potenziell Remote Code Execution, Datenexfiltration, vollständige Kontoübernahme und vollständige Kompromittierung der zugrunde liegenden Infrastruktur ermöglichen. Es ist von höchster Wichtigkeit, dass dies mit größter Dringlichkeit behoben wird.

Referenz: https://cwe.mitre.org/data/definitions/79.html

Bitte berücksichtigt diesen Bericht für euer Bug-Bounty-Programm. Ich freue mich auf eure Antwort.`,
  },
  {
    id: "ja-legit",
    language: "ja",
    variant: "legit",
    text: `タイトル: /admin/comments の "title" フィールドにおける Stored XSS
影響対象: example-app v2.4.1、コミット a1b2c3d、src/admin/comments.js 142 行目。

再現手順:
1. 低権限ユーザーとしてログインする。
2. /api/comments に title=<svg/onload=alert(1)> で POST する。
3. 管理者として /admin/comments を開く。管理者のブラウザでペイロードが実行される。

原因: title フィールドは renderComment() 内で innerHTML を使用してエスケープなしで描画されている。src/admin/comments.js の sanitizeComment() は本文のみを処理し、タイトルは処理していない。

影響: セッション Cookie に HttpOnly が付与されていないため、攻撃者は管理者のセッションを乗っ取ることができる。Firefox 124 および Chrome 123 で確認済み。CWE-79。

修正案: title を既存の escapeHtml() ヘルパーに通すか、マークアップを含むべきでないフィールドについては renderComment() を textContent に切り替える。`,
  },
  {
    id: "ja-slop",
    language: "ja",
    variant: "slop",
    text: `セキュリティチームの皆様、いつもお世話になっております :)

貴社のアプリケーションに、深刻な結果をもたらす可能性のある潜在的な重大脆弱性について報告させていただきます。本問題が攻撃者に悪意ある行為を許し、ユーザーの安全性を損なう可能性があることに留意することが重要です。

現代のウェブセキュリティの領域において、クロスサイトスクリプティングは組織が包括的に深く掘り下げるべき最重要課題を表しています。本脆弱性は多面的であり、貴社アプリケーションの攻撃対象領域全体にわたって広範な影響を及ぼす可能性があります。

再現手順: 細工したリクエストをアプリケーションに送信する。入力が適切にサニタイズされないことを観察する。これにより攻撃者が他のユーザーのコンテキストで任意のコードを実行できる可能性があります。

影響: 本脆弱性は潜在的にリモートコード実行、データ流出、完全なアカウント乗っ取り、および基盤インフラの完全な侵害を許す可能性があります。最大限の緊急性をもって対処されることが極めて重要です。

参考: https://cwe.mitre.org/data/definitions/79.html

バグバウンティプログラムでのご検討をよろしくお願いいたします。ご返信をお待ちしております。`,
  },
  {
    id: "ru-legit",
    language: "ru",
    variant: "legit",
    text: `Заголовок: Stored XSS в /admin/comments через поле "title"
Затронуто: example-app v2.4.1, коммит a1b2c3d, файл src/admin/comments.js строка 142.

Шаги воспроизведения:
1. Войти как пользователь с низкими привилегиями.
2. Выполнить POST на /api/comments с title=<svg/onload=alert(1)>.
3. Открыть /admin/comments под администратором. Полезная нагрузка выполняется в браузере администратора.

Причина: поле title рендерится через innerHTML в функции renderComment() без экранирования. Функция sanitizeComment() в src/admin/comments.js санирует только тело, но не заголовок.

Воздействие: атакующий может перехватить сессию администратора, поскольку cookie сессии не помечены как HttpOnly. Проверено в Firefox 124 и Chrome 123. CWE-79.

Предлагаемое исправление: пропускать title через существующий помощник escapeHtml() или переключить renderComment() на textContent для полей, которые не должны содержать разметку.`,
  },
  {
    id: "ru-slop",
    language: "ru",
    variant: "slop",
    text: `Здравствуйте, команда безопасности, надеюсь у вас всё хорошо :)

Я хотел бы сообщить о потенциальной критической уязвимости в вашем приложении, которая может привести к серьёзным последствиям. Важно отметить, что эта проблема может позволить злоумышленникам выполнять вредоносные действия и поставить под угрозу безопасность ваших пользователей.

В сфере современной веб-безопасности межсайтовый скриптинг представляет собой первостепенную проблему, в которую организациям необходимо всесторонне погружаться. Данная уязвимость многогранна и может иметь далеко идущие последствия для всей поверхности атаки вашего приложения.

Шаги воспроизведения: отправьте специально подготовленный запрос приложению. Обратите внимание, что ввод не санируется должным образом. Это может позволить злоумышленнику выполнить произвольный код в контексте других пользователей.

Воздействие: данная уязвимость потенциально может позволить удалённое выполнение кода, эксфильтрацию данных, полный захват учётной записи и полную компрометацию базовой инфраструктуры. Крайне важно, чтобы это было решено с максимальной срочностью.

Ссылка: https://cwe.mitre.org/data/definitions/79.html

Пожалуйста, рассмотрите этот отчёт для вашей программы bug bounty. С нетерпением жду вашего ответа.`,
  },
  {
    id: "pt-legit",
    language: "pt",
    variant: "legit",
    text: `Título: XSS armazenado em /admin/comments via o campo "title"
Afetado: example-app v2.4.1, commit a1b2c3d, arquivo src/admin/comments.js linha 142.

Passos para reproduzir:
1. Fazer login como usuário com baixos privilégios.
2. Enviar POST para /api/comments com title=<svg/onload=alert(1)>.
3. Acessar /admin/comments como administrador. O payload é executado no navegador do administrador.

Causa raiz: o campo title é renderizado com innerHTML em renderComment() sem escapamento. A função sanitizeComment() em src/admin/comments.js só sanitiza o corpo, não o título.

Impacto: um atacante pode sequestrar sessões de administrador porque os cookies de sessão não são HttpOnly. Testado no Firefox 124 e Chrome 123. CWE-79.

Correção sugerida: passar o title pelo helper existente escapeHtml(), ou trocar renderComment() para textContent nos campos que não devem conter marcação.`,
  },
  {
    id: "pt-slop",
    language: "pt",
    variant: "slop",
    text: `Olá equipe de segurança, espero que estejam todos bem :)

Gostaria de reportar uma possível vulnerabilidade crítica em sua aplicação que poderia levar a consequências severas. É importante observar que este problema poderia permitir que atacantes realizem ações maliciosas e comprometam a segurança de seus usuários.

No âmbito da segurança web moderna, o cross-site scripting representa uma preocupação primordial na qual as organizações devem mergulhar de forma abrangente. Esta vulnerabilidade é multifacetada e poderia ter implicações de longo alcance em toda a tapeçaria da superfície de ataque de sua aplicação.

Passos para reproduzir: envie uma requisição manipulada à aplicação. Observe que a entrada não é sanitizada adequadamente. Isso pode permitir que um atacante execute código arbitrário no contexto de outros usuários.

Impacto: Esta vulnerabilidade poderia potencialmente permitir execução remota de código, exfiltração de dados, tomada completa de contas e comprometimento completo da infraestrutura subjacente. É primordial que isso seja tratado com a máxima urgência.

Referência: https://cwe.mitre.org/data/definitions/79.html

Por favor considerem este relatório para o seu programa de bug bounty. Aguardo a resposta de vocês.`,
  },
  {
    id: "ar-legit",
    language: "ar",
    variant: "legit",
    text: `العنوان: ثغرة XSS مُخزَّنة في /admin/comments عبر الحقل "title"
المتأثر: example-app الإصدار 2.4.1، الالتزام a1b2c3d، الملف src/admin/comments.js السطر 142.

خطوات إعادة الإنتاج:
1. تسجيل الدخول كمستخدم بصلاحيات منخفضة.
2. إرسال طلب POST إلى /api/comments بالقيمة title=<svg/onload=alert(1)>.
3. فتح /admin/comments كمسؤول. تُنفَّذ الحمولة في متصفح المسؤول.

السبب الجذري: يُعرض الحقل title بواسطة innerHTML داخل الدالة renderComment() دون أي escape. الدالة sanitizeComment() في src/admin/comments.js تنظِّف الجسم فقط وليس العنوان.

التأثير: يمكن للمهاجم اختطاف جلسات المسؤول لأن ملفات تعريف الارتباط للجلسة ليست HttpOnly. تم الاختبار على Firefox 124 و Chrome 123. CWE-79.

الإصلاح المقترح: تمرير الحقل title عبر المساعد الموجود escapeHtml()، أو تبديل renderComment() إلى textContent للحقول التي لا يجب أن تحتوي على وسوم.`,
  },
  {
    id: "ar-slop",
    language: "ar",
    variant: "slop",
    text: `مرحباً فريق الأمان، أتمنى أن تكونوا بخير :)

أود الإبلاغ عن ثغرة أمنية حرجة محتملة في تطبيقكم قد تؤدي إلى عواقب وخيمة. من المهم ملاحظة أن هذه المشكلة قد تسمح للمهاجمين بتنفيذ إجراءات خبيثة والإضرار بأمن المستخدمين لديكم.

في مجال أمن الويب الحديث، تمثل ثغرات البرمجة عبر المواقع مصدر قلق بالغ الأهمية يجب على المؤسسات الغوص فيه بشكل شامل. هذه الثغرة متعددة الأوجه ويمكن أن يكون لها آثار بعيدة المدى عبر كامل سطح الهجوم لتطبيقكم.

خطوات إعادة الإنتاج: إرسال طلب مُعدَّل إلى التطبيق. ملاحظة أن المدخلات لا يتم تنقيتها بشكل صحيح. قد يسمح ذلك للمهاجم بتنفيذ شيفرة عشوائية في سياق مستخدمين آخرين.

التأثير: قد تسمح هذه الثغرة بتنفيذ التعليمات البرمجية عن بُعد، وتسريب البيانات، والاستيلاء الكامل على الحساب، والاختراق الكامل للبنية التحتية الأساسية. من الأهمية القصوى معالجة هذا الأمر بأقصى درجات الاستعجال.

المرجع: https://cwe.mitre.org/data/definitions/79.html

يرجى النظر في هذا التقرير لبرنامج مكافآت الأخطاء لديكم. في انتظار ردكم.`,
  },
];
