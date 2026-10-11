import sys, json, math
sys.path.insert(0,'/workspace/inkwash')
import numpy as np, cv2
from PIL import Image
from inkwash.core import Canvas, INK, INDIGO, make_paper, fbm, smoothstep
SRC='/workspace/inkwash/shanshui/'
big=Image.open(SRC+'shanshui.png').convert('RGB')
lab=json.load(open(SRC+'labels.json'))['labels']
def crop(name, cx, cy, w, h, out_w=None):
    x0=int(max(0,min(2400-w,cx-w/2))); y0=int(max(0,min(3200-h,cy-h/2)))
    im=big.crop((x0,y0,x0+w,y0+h))
    if out_w: im=im.resize((out_w,int(h*out_w/w)),Image.LANCZOS)
    im.save(f'a/{name}.jpg',quality=92); print(name,x0,y0,w,h)
C={ # technique crops (center from labels.json, size)
 'pima':(540,1150,420,420),'fupi':(1150,2640,420,420),'midian':(lab['米点皴'][0][0],lab['米点皴'][0][1],420,420),
 'diantai':(1381,260,420,420),'jimo':(1150,700,420,420),'pomo':(985,1975,320,320),
 'pomo2':(300,3020,520,520),'liubai':(1548,1180,420,420),'feibai':(110,2300,300,300),
 'songzhen':(770,2135,260,260),'jiezi':(390,1975,240,240),'gezi':(837,2303,300,300),'goule':(960,300,420,420),
 'stroke_crop':(1150,2600,300,300)}
for k,v in C.items(): crop(k,*v)
for i,(k,(x,y)) in enumerate([('qing',(470,760)),('dan',(1060,1880)),('zhong',(1820,900)),('nong',(820,3080)),('jiao',(630,2451))]):
    crop('wu_'+k,x,y,200,200)
big.resize((1200,1600),Image.LANCZOS).save('a/thumb.jpg',quality=92)

# ---- engine demos (real inkwash.core) ----
def comp(cv, layers):
    tot=np.zeros((cv.h,cv.w,3),np.float32)
    for L in layers: L.finalize(); tot+=L.A
    return cv.paper*np.exp(-tot)
def save(img,name):
    Image.fromarray((np.clip(img,0,1)*255+.5).astype(np.uint8)).save(f'a/{name}.png')
# paper
paper,fiber=make_paper(360,560,seed=8)
save(paper,'paper'); 
g=paper.mean(2); g=np.clip((g-g.mean())*9+0.62,0,1); save(np.repeat(g[...,None],3,2)*np.array([1,.97,.9]),'paper_boost')
save(np.repeat(fiber[...,None],3,2),'fiber')
# overlapping washes -> stacking
cv=Canvas(620,360,11); L=cv.layer('w',halo=0.9)
yy,xx=np.mgrid[0:360,0:620].astype(np.float32)
for (cx,cy) in [(220,150),(380,150),(300,240)]:
    f=smoothstep(1.0,0.6,np.hypot(xx-cx,yy-cy)/130)
    L.wash(0,0,f,INK,dens=0.45,seeds=[(cx,cy)],edge=0.5,gran=0.4)
save(comp(cv,[L]),'stack')
# strokes
cv=Canvas(900,560,21); L=cv.layer('s',halo=0.9)
def path(y): return [(60,y),(300,y-25),(560,y+20),(840,y-10)]
L.stroke(path(80),20,ink=1.5,dry=0.0,wet=0.5,taper=(0.0,0.0),start_w=1,end_w=1,rough=0.0,wobble=0.0,bristle=0.0)
L.stroke(path(210),20,ink=1.5,dry=0.1,wet=0.5,taper=(0.2,0.45),start_w=0.3,end_w=0.05)
L.stroke(path(340),22,ink=1.5,dry=0.85,wet=0.2,taper=(0.05,0.4),start_w=1.0,end_w=0.1,bristle=1.5)
L.stroke(path(470),24,ink=0.8,dry=0.0,wet=1.6,pool=0.9,taper=(0.1,0.3),start_w=0.6,end_w=0.3)
save(comp(cv,[L]),'strokes')
# five tones
cv=Canvas(900,200,31); L=cv.layer('t',halo=0.9); yy,xx=np.mgrid[0:200,0:900].astype(np.float32)
for i,ink in enumerate([0.12,0.3,0.6,1.0,1.8]):
    f=smoothstep(1.0,0.7,np.hypot(xx-(90+i*180),yy-100)/75)
    L.wash(0,0,f,INK,dens=ink,seeds=[(90+i*180,100)],edge=0.4,gran=0.4)
save(comp(cv,[L]),'tones')
