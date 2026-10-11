T = [  # key, name, func, desc
 ('pima','披麻皴','Massif._pima','沿山坡斜度，每处 2–4 条长而软的细笔成一束（dry 0.35–0.65），像麻线顺坡披下。'),
 ('fupi','斧劈皴','brush.fupi · Massif._fupi','侧锋宽笔：起笔钝重 start_w=1，收笔拖尖 end_w=0.02；阴面更密更黑。'),
 ('midian','米点皴','brush.midot · atmos.mi_hills','横向拉长 1.8–2.6 倍的湿墨点 dot(wet=1)，一排排叠成远山。'),
 ('diantai','点苔','brush.moss','在山顶轮廓线上随机撒 1–3 个焦墨点（ink≈1.5），略竖向拉长。'),
 ('jimo','积墨','Massif.lobe','每座山体染两遍 wash，第二遍更小更浓；越近山脚越深，再叠皴纹。'),
 ('goule','勾勒 + 渲染','rocks.outline','轮廓线每 4–9 个点断成一笔，约 15% 留缺口，粗细随机，再压在墨染上。'),
 ('pomo','破墨','brush.pomo','先铺一层淡湿墨（dens 0.26），趁“湿”再点 3–5 团浓墨，边缘起水渍。'),
 ('pomo2','泼墨','brush.pomo_splash','fbm 噪声扰乱椭圆边界成大墨团（dens 2.4），外围再洒 8–15 个墨滴。'),
 ('liubai','留白','atmos.waterfall_mask · mist_mask','合成时把这块的墨量乘 (1−mask) 直接扣掉，露出纸色，就成了瀑布与云。'),
 ('feibai','飞白','Layer.stroke(dry=…)','笔毛条纹低于“干度”阈值处不上墨；越到笔尾越干，丝丝露白。'),
 ('songzhen','松针','trees.needle_cluster','9–13 根短线围成半圆扇，5–8 扇拼成一片松盖，底下衬花青淡染。'),
 ('jiezi','介字点 / 个字点','trees.jiezi · trees.gezi','从一点向下左右各撇一笔成“介”（图）；亭旁树用三片尖叶张开的“个”字点。'),
]
cells = '\n'.join(f'''<div class="tc"><img src="a/{k}.jpg"><div class="tn">{n}</div><div class="fn">{f.replace(' · ','<br>')}</div><div class="td">{d}</div></div>''' for k,n,f,d in T)
R = [('r1','r1','多边形 + 散点纹理，像示意图：子弹头山、箭头状斧劈'),
     ('r2','r2','重写为互相遮挡的山体 massif.py，有了结构；但主峰太黑、远近颠倒'),
     ('r3','r3','主峰变宽、内有褶皱；远山变淡；中景小山加矾头'),
     ('r4','r4','前景石块向下延伸出画外（extend），岸边去掉珠串点'),
     ('r5','r5','看全分辨率局部：斧劈更利、瀑布双唇、蟹爪枯树、印章'),
     ('r6_final','r6 定稿','泼墨加重、破墨挪到空坡、崖侧勾线、遮挡不再有硬缺口')]
rounds = '\n'.join(f'<div class="rc"><img src="/workspace/inkwash/shanshui/rounds/{f}.jpg"><div class="rn">{n}</div><div class="rd">{d}</div></div>' for f,n,d in R)
wu = '\n'.join(f'<div class="wu"><img src="a/wu_{k}.jpg"><span>{c}</span><code>{v}</code></div>' for k,c,v in
   [('jiao','焦','ink 1.5'),('nong','浓','0.9–0.95'),('zhong','重','≈0.6'),('dan','淡','≈0.34'),('qing','清','0.07–0.1')][::-1])
html = open('tpl.html').read().replace('{{CELLS}}', cells).replace('{{ROUNDS}}', rounds).replace('{{WU}}', wu)
open('info.html','w').write(html)
