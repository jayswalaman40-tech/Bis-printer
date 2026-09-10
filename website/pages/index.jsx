import Head from 'next/head';

export default function Home() {
  return (<>
    <Head><title>Hallmark Desk</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" /></Head>
    <main style={{minHeight:'100vh',display:'flex',flexDirection:'column',alignItems:'center',
      justifyContent:'center',background:'#1B2430',color:'#F5F4EF',
      fontFamily:'system-ui,sans-serif',textAlign:'center',padding:'24px'}}>
      <div style={{fontWeight:600,fontSize:10,letterSpacing:'.15em',color:'#A8802A',
        border:'1px solid #A8802A',padding:'4px 10px',borderRadius:2,marginBottom:14}}>BIS HALLMARKED</div>
      <h1 style={{fontWeight:400,fontSize:26,marginBottom:8}}>Hallmark Desk</h1>
      <p style={{color:'#8A9099',fontSize:14,maxWidth:420,lineHeight:1.6}}>
        Scan a tag barcode to view its verification page (HUID · Weight · Purity).
      </p>
      <p style={{color:'#C4CBBE',fontSize:11,marginTop:32,letterSpacing:'.08em'}}>
        Powered by Hallmark Desk · NexaCore AI</p>
    </main>
  </>);
}
