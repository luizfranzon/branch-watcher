# Branch Watcher

Extensão VS Code que antecipa quais branches locais vão conflitar ao serem mergeadas numa branch de referência escolhida pelo usuário.

## Language

**Repositório observado**:
O único repositório git analisado num dado momento; o da pasta raiz, ou o escolhido pelo usuário quando há vários.
_Avoid_: projeto, workspace

**Branch base**:
A ref contra a qual todas as branches locais são comparadas; por padrão a versão remota (ex. `origin/main`), configurável para local.
_Avoid_: branch principal, target, main

**Branch analisada**:
Qualquer branch local, exceto a contraparte local da Branch base, cuja mesclagem na Branch base é simulada.
_Avoid_: feature branch, branch local

**Branch integrada**:
Branch analisada cujo último commit já está contido na Branch base; não conta como conflito nem como pendente.
_Avoid_: mergeada, merged

**Branch conflitante**:
Branch analisada cuja mesclagem simulada na Branch base resulta em conflito. É a única que entra na contagem do badge.
_Avoid_: branch quebrada, branch com problema

**Arquivo conflitante**:
Arquivo que, na mesclagem simulada de uma Branch conflitante, não pôde ser combinado automaticamente.

**Resolução**:
Ato de trazer a Branch base para dentro de uma Branch conflitante via merge, para o usuário corrigir os conflitos antes do PR.
_Avoid_: fix, rebase

**Branch limpa**:
Branch analisada cuja mesclagem simulada na Branch base não gera conflito.

**Upstream**:
A branch remota configurada como rastreada por uma Branch analisada. Só ela é considerada para exclusão remota.
_Avoid_: branch remota, origin/<nome>

**Limpeza**:
Exclusão de Branches integradas, local e no Upstream; o Upstream só é excluído se também estiver contido na Branch base após um fetch imediato.
_Avoid_: prune, delete

**Branch protegida**:
Branch que nunca entra na Limpeza, mesmo integrada; continua sendo analisada quanto a conflito.
_Avoid_: branch fixa, branch permanente

**Divergência**:
Quantidade de commits que a Branch analisada tem à frente e atrás da Branch base.
_Avoid_: desatualizada, defasagem
