# Branch Watcher

Mostra, antes de abrir o PR, quais branches locais vão conflitar ao serem mescladas na **Branch base** escolhida (ex. `origin/main`). Vocabulário em [CONTEXT.md](CONTEXT.md).

## Funcionalidades

- Ícone na Activity Bar com badge = nº de branches conflitantes.
- Painel com grupos **Conflitantes**, **Limpas**, **Integradas** e **Com erro**; cada branch mostra `↑à frente ↓atrás`.
- Arquivos conflitantes listados sob a branch; clique abre diff base ↔ branch.
- Filtros por autor e por data do último commit (últimos 7/30/90 dias ou range personalizado); badge e avisos seguem o filtro.
- Merge simulado com `git merge-tree`: não toca no working tree.
- Reanalisa quando refs mudam e faz fetch periódico.
- Aviso quando uma branch limpa passa a conflitar.
- **Resolver agora**: checkout da branch + merge da base, para corrigir os conflitos no editor.
- **Excluir integradas**: exclui branches já contidas na base, localmente e no upstream. O upstream passa por fetch antes e só é excluído se não tiver commits fora da base.

## Requisitos

git 2.38 ou superior.

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `branchWatcher.fetchIntervalMinutes` | `10` | Intervalo do fetch automático; `0` desliga. |
| `branchWatcher.protectedBranches` | `["homologacao", "master", "main"]` | Nunca entram na exclusão. Aceita `*`. |
| `branchWatcher.notifyNewConflicts` | `true` | Avisa quando surge conflito novo. |

## Como traduzir

A extensão é escrita em pt-BR. Os textos ficam em dois lugares:

- `l10n/bundle.l10n.json`: textos do código. Copie para `l10n/bundle.l10n.<idioma>.json` (ex. `bundle.l10n.en.json`) e traduza os valores, mantendo as chaves.
- `package.nls.json`: nomes de comandos, settings e telas vazias. Copie para `package.nls.<idioma>.json` e traduza os valores.

Ao adicionar textos novos no código (`vscode.l10n.t(...)`), rode `pnpm run l10n` para atualizar `l10n/bundle.l10n.json`.

## Desenvolvimento

```sh
pnpm install
pnpm run compile
pnpm test
```

F5 no VS Code abre uma janela com a extensão carregada.
