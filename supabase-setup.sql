-- 資産管理アプリ: 端末どうしの共有用(Supabase の SQL Editor に貼って Run する)
-- 中身はすべて端末側で暗号化されたデータ。サーバーは暗号文しか持たない。
-- 表そのものには誰もアクセスできないようにして、決まった3つの関数だけを公開する。

create table if not exists public.shisan_vault (
  id text primary key check (id ~ '^[0-9a-f]{64}$'),
  rev bigint not null default 1,
  data text not null check (length(data) <= 2000000),
  updated_at timestamptz not null default now()
);
alter table public.shisan_vault enable row level security;       -- ポリシーを作らない = 直接は誰も読み書きできない
revoke all on public.shisan_vault from anon, authenticated;

create or replace function public.shisan_get(p_id text)
returns table(rev bigint, data text)
language sql security definer set search_path = public as $$
  select v.rev, v.data from public.shisan_vault v where v.id = p_id;
$$;

-- p_base = 手元が知っている版(新規は 0)。版が食い違ったら -1 を返して上書きしない
create or replace function public.shisan_put(p_id text, p_base bigint, p_data text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if p_id !~ '^[0-9a-f]{64}$' or length(p_data) > 2000000 then raise exception 'bad request'; end if;
  if p_base = 0 then
    insert into public.shisan_vault(id, rev, data) values (p_id, 1, p_data) on conflict (id) do nothing;
    if found then return 1; end if;
    return -1;
  end if;
  update public.shisan_vault set rev = rev + 1, data = p_data, updated_at = now()
   where id = p_id and rev = p_base returning rev into n;
  return coalesce(n, -1);
end $$;

create or replace function public.shisan_delete(p_id text)
returns void
language sql security definer set search_path = public as $$
  delete from public.shisan_vault where id = p_id;
$$;

revoke all on function public.shisan_get(text), public.shisan_put(text,bigint,text), public.shisan_delete(text) from public;
grant execute on function public.shisan_get(text), public.shisan_put(text,bigint,text), public.shisan_delete(text) to anon, authenticated;
